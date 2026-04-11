package redis

import (
	"context"
	"errors"
	"testing"

	"github.com/qsnake66/infraview/internal/config"
	"github.com/qsnake66/infraview/internal/connector"
	goredis "github.com/redis/go-redis/v9"
)

type fakeRedisClient struct {
	pingCmd  *goredis.StatusCmd
	infoCmd  *goredis.StringCmd
	closeErr error
	closed   bool
}

func (f *fakeRedisClient) Ping(context.Context) *goredis.StatusCmd {
	return f.pingCmd
}

func (f *fakeRedisClient) Info(context.Context, ...string) *goredis.StringCmd {
	return f.infoCmd
}

func (f *fakeRedisClient) Close() error {
	f.closed = true
	return f.closeErr
}

func TestResolveRedisSettings(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name    string
		cfg     config.ConnectionConfig
		want    redisSettings
		wantErr bool
	}{
		{
			name: "standalone falls back to host and port",
			cfg: config.ConnectionConfig{
				Host: "cache.example",
				Port: 6379,
			},
			want: redisSettings{
				mode:      config.RedisModeStandalone,
				address:   "cache.example:6379",
				separator: ":",
			},
		},
		{
			name: "cluster uses explicit addresses",
			cfg: config.ConnectionConfig{
				RedisConfig: &config.RedisConfig{
					Mode:      config.RedisModeCluster,
					Addresses: []string{"node1.example:7000", "node2.example:7001"},
					Separator: ",",
				},
			},
			want: redisSettings{
				mode:      config.RedisModeCluster,
				addresses: []string{"node1.example:7000", "node2.example:7001"},
				separator: ",",
			},
		},
		{
			name: "sentinel requires master name",
			cfg: config.ConnectionConfig{
				RedisConfig: &config.RedisConfig{
					Mode:          config.RedisModeSentinel,
					SentinelAddrs: []string{"sentinel.example:26379"},
					MasterName:    "mymaster",
					Database:      2,
				},
			},
			want: redisSettings{
				mode:          config.RedisModeSentinel,
				sentinelAddrs: []string{"sentinel.example:26379"},
				masterName:    "mymaster",
				database:      2,
				separator:     ":",
			},
		},
		{
			name: "sentinel missing master name fails",
			cfg: config.ConnectionConfig{
				RedisConfig: &config.RedisConfig{
					Mode:          config.RedisModeSentinel,
					SentinelAddrs: []string{"sentinel.example:26379"},
				},
			},
			wantErr: true,
		},
	}

	for _, tc := range tests {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			got, err := resolveRedisSettings(tc.cfg)
			if tc.wantErr {
				if err == nil {
					t.Fatalf("expected error")
				}
				return
			}
			if err != nil {
				t.Fatalf("resolve redis settings: %v", err)
			}
			if got.mode != tc.want.mode {
				t.Fatalf("unexpected mode: got %q want %q", got.mode, tc.want.mode)
			}
			if got.separator != tc.want.separator {
				t.Fatalf("unexpected separator: got %q want %q", got.separator, tc.want.separator)
			}
			if got.address != tc.want.address {
				t.Fatalf("unexpected address: got %q want %q", got.address, tc.want.address)
			}
			if got.masterName != tc.want.masterName {
				t.Fatalf("unexpected master name: got %q want %q", got.masterName, tc.want.masterName)
			}
			if got.database != tc.want.database {
				t.Fatalf("unexpected database: got %d want %d", got.database, tc.want.database)
			}
			if len(got.addresses) != len(tc.want.addresses) {
				t.Fatalf("unexpected addresses: got %#v want %#v", got.addresses, tc.want.addresses)
			}
			if len(got.sentinelAddrs) != len(tc.want.sentinelAddrs) {
				t.Fatalf("unexpected sentinel addrs: got %#v want %#v", got.sentinelAddrs, tc.want.sentinelAddrs)
			}
		})
	}
}

func TestRedisConnectorPingGetInfoAndClose(t *testing.T) {
	t.Parallel()

	fake := &fakeRedisClient{
		pingCmd: goredis.NewStatusResult("PONG", nil),
		infoCmd: goredis.NewStringResult(`# Server
redis_version:7.2.5
uptime_in_seconds:1234
# Clients
connected_clients:8
# Replication
role:master
`, nil),
	}

	conn := newRedisConnector(fake, config.ConnectionConfig{Host: "cache.example", Port: 6379}, redisSettings{
		mode:      config.RedisModeStandalone,
		address:   "cache.example:6379",
		separator: ":",
		database:  2,
	})

	if err := conn.Ping(context.Background()); err != nil {
		t.Fatalf("ping: %v", err)
	}

	info, err := conn.GetInfo(context.Background())
	if err != nil {
		t.Fatalf("get info: %v", err)
	}

	if info.Version != "7.2.5" {
		t.Fatalf("unexpected version: %q", info.Version)
	}
	if info.Database != "2" {
		t.Fatalf("unexpected database: %q", info.Database)
	}
	if info.Host != "cache.example" {
		t.Fatalf("unexpected host: %q", info.Host)
	}
	if info.Port != "6379" {
		t.Fatalf("unexpected port: %q", info.Port)
	}
	if info.Extra["connected_clients"] != "8" {
		t.Fatalf("unexpected connected clients: %#v", info.Extra["connected_clients"])
	}
	if info.Extra["role"] != "master" {
		t.Fatalf("unexpected role: %#v", info.Extra["role"])
	}

	if err := conn.Close(); err != nil {
		t.Fatalf("close: %v", err)
	}
	if !fake.closed {
		t.Fatalf("expected close to be forwarded")
	}
}

func TestNormalizeRedisError(t *testing.T) {
	t.Parallel()

	err := normalizeRedisError(errors.New("WRONGPASS invalid username-password pair"))
	if !errors.Is(err, connector.ErrForbidden) {
		t.Fatalf("expected forbidden error, got %v", err)
	}
}

func TestNewRedisClientBuildsAllModes(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name     string
		settings redisSettings
	}{
		{
			name: "standalone",
			settings: redisSettings{
				mode:      config.RedisModeStandalone,
				address:   "cache.example:6379",
				username:  "app",
				database:  1,
				separator: ":",
			},
		},
		{
			name: "cluster",
			settings: redisSettings{
				mode:      config.RedisModeCluster,
				addresses: []string{"node1.example:7000", "node2.example:7001"},
				username:  "app",
				separator: ":",
			},
		},
		{
			name: "sentinel",
			settings: redisSettings{
				mode:          config.RedisModeSentinel,
				sentinelAddrs: []string{"sentinel.example:26379"},
				masterName:    "mymaster",
				username:      "app",
				database:      2,
				separator:     ":",
			},
		},
	}

	for _, tc := range tests {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			client, err := newRedisClient(tc.settings, "secret")
			if err != nil {
				t.Fatalf("new redis client: %v", err)
			}
			if client == nil {
				t.Fatalf("expected client")
			}
			if err := client.Close(); err != nil {
				t.Fatalf("close client: %v", err)
			}
		})
	}
}

func TestResolveHostWithLookup(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name     string
		host     string
		inDocker bool
		lookup   func(string) ([]string, error)
		want     string
	}{
		{
			name:     "non loopback host unchanged",
			host:     "redis.internal",
			inDocker: true,
			want:     "redis.internal",
		},
		{
			name:     "localhost outside docker unchanged",
			host:     "localhost",
			inDocker: false,
			want:     "localhost",
		},
		{
			name:     "localhost inside docker resolves gateway ip",
			host:     "localhost",
			inDocker: true,
			lookup: func(string) ([]string, error) {
				return []string{"192.168.65.2"}, nil
			},
			want: "192.168.65.2",
		},
		{
			name:     "loopback ip inside docker resolves gateway ip",
			host:     "127.0.0.1",
			inDocker: true,
			lookup: func(string) ([]string, error) {
				return []string{"192.168.65.2"}, nil
			},
			want: "192.168.65.2",
		},
		{
			name:     "inside docker falls back to host.docker.internal",
			host:     "localhost",
			inDocker: true,
			lookup: func(string) ([]string, error) {
				return nil, errors.New("lookup failed")
			},
			want: "host.docker.internal",
		},
	}

	for _, tc := range tests {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			got := resolveHostWithLookup(tc.host, tc.inDocker, tc.lookup)
			if got != tc.want {
				t.Fatalf("resolveHostWithLookup(%q) = %q, want %q", tc.host, got, tc.want)
			}
		})
	}
}
