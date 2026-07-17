package redis

import (
	"context"
	"errors"
	"strconv"
	"testing"
	"time"

	goredis "github.com/redis/go-redis/v9"
	"github.com/zxchlorka/kizuna/internal/config"
	"github.com/zxchlorka/kizuna/internal/connector"
)

type fakeRedisClient struct {
	pingCmd           *goredis.StatusCmd
	infoCmd           *goredis.StringCmd
	closeErr          error
	closed            bool
	scanClient        redisScanClient
	typeValue         string
	ttlValue          time.Duration
	setCalls          int
	setArgsCalls      int
	expireCalls       int
	lastSetExpiration time.Duration
	lastExpireTTL     time.Duration
	lastSetArgs       *goredis.SetArgs
	doResult          any
	doErr             error
	xInfoGroups       []goredis.XInfoGroup
	pipelineCmders    []goredis.Cmder
	pipelineErr       error
	delResult         int64
	delCalls          [][]string
	xRangeMessages    []goredis.XMessage
	xRevRangeMessages []goredis.XMessage
	hscanPairs        []string
	hlenResult        int64
}

type fakeScanClient struct {
	scanPages map[string][][]string
}

func (f *fakeScanClient) Scan(ctx context.Context, cursor uint64, pattern string, count int64) *goredis.ScanCmd {
	if err := ctx.Err(); err != nil {
		return goredis.NewScanCmdResult(nil, 0, err)
	}

	pages := f.scanPages[pattern]
	if int(cursor) >= len(pages) {
		return goredis.NewScanCmdResult(nil, 0, nil)
	}

	nextCursor := uint64(0)
	if int(cursor)+1 < len(pages) {
		nextCursor = cursor + 1
	}

	return goredis.NewScanCmdResult(pages[cursor], nextCursor, nil)
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

func (f *fakeRedisClient) Type(context.Context, string) *goredis.StatusCmd {
	if f.typeValue == "" {
		return goredis.NewStatusResult("string", nil)
	}
	return goredis.NewStatusResult(f.typeValue, nil)
}

func (f *fakeRedisClient) Do(context.Context, ...any) *goredis.Cmd {
	return goredis.NewCmdResult(f.doResult, f.doErr)
}

// fakePipeliner answers Type/TTL pipeline calls from the parent fake client so
// the batched leaf-describe path works in tests. Other Pipeliner methods panic
// via the embedded nil interface.
type fakePipeliner struct {
	goredis.Pipeliner
	client *fakeRedisClient
	cmds   []goredis.Cmder
}

func (p *fakePipeliner) Type(ctx context.Context, key string) *goredis.StatusCmd {
	cmd := p.client.Type(ctx, key)
	p.cmds = append(p.cmds, cmd)
	return cmd
}

func (p *fakePipeliner) TTL(ctx context.Context, key string) *goredis.DurationCmd {
	cmd := p.client.TTL(ctx, key)
	p.cmds = append(p.cmds, cmd)
	return cmd
}

func (f *fakeRedisClient) Pipelined(_ context.Context, fn func(goredis.Pipeliner) error) ([]goredis.Cmder, error) {
	if f.pipelineCmders != nil || f.pipelineErr != nil {
		return f.pipelineCmders, f.pipelineErr
	}
	pipe := &fakePipeliner{client: f}
	if err := fn(pipe); err != nil {
		return nil, err
	}
	return pipe.cmds, nil
}

type fakeClusterTopology struct {
	masters []string
	clients map[string]redisScanClient
	closed  bool
}

func (t *fakeClusterTopology) Masters(context.Context) ([]string, error) {
	return t.masters, nil
}

func (t *fakeClusterTopology) NodeScanClient(addr string) (redisScanClient, error) {
	client, ok := t.clients[addr]
	if !ok {
		return nil, errors.New("unknown node " + addr)
	}
	return client, nil
}

func (t *fakeClusterTopology) Close() error {
	t.closed = true
	return nil
}

func (f *fakeRedisClient) TTL(context.Context, string) *goredis.DurationCmd {
	if f.ttlValue == 0 {
		return goredis.NewDurationResult(-1*time.Second, nil)
	}
	return goredis.NewDurationResult(f.ttlValue, nil)
}

func (f *fakeRedisClient) Get(context.Context, string) *goredis.StringCmd {
	return goredis.NewStringResult("", nil)
}

func (f *fakeRedisClient) Set(_ context.Context, _ string, _ any, expiration time.Duration) *goredis.StatusCmd {
	f.setCalls++
	f.lastSetExpiration = expiration
	return goredis.NewStatusResult("OK", nil)
}

func (f *fakeRedisClient) SetArgs(_ context.Context, _ string, _ any, a goredis.SetArgs) *goredis.StatusCmd {
	f.setArgsCalls++
	args := a
	f.lastSetArgs = &args
	return goredis.NewStatusResult("OK", nil)
}

func (f *fakeRedisClient) Del(_ context.Context, keys ...string) *goredis.IntCmd {
	f.delCalls = append(f.delCalls, append([]string(nil), keys...))
	if f.delResult > 0 {
		return goredis.NewIntResult(f.delResult, nil)
	}
	return goredis.NewIntResult(int64(len(keys)), nil)
}

func (f *fakeRedisClient) Scan(ctx context.Context, cursor uint64, pattern string, count int64) *goredis.ScanCmd {
	if f.scanClient != nil {
		return f.scanClient.Scan(ctx, cursor, pattern, count)
	}
	return goredis.NewScanCmdResult(nil, 0, nil)
}

func (f *fakeRedisClient) Exists(context.Context, ...string) *goredis.IntCmd {
	return goredis.NewIntResult(0, nil)
}

func (f *fakeRedisClient) Rename(context.Context, string, string) *goredis.StatusCmd {
	return goredis.NewStatusResult("OK", nil)
}

func (f *fakeRedisClient) Expire(_ context.Context, _ string, expiration time.Duration) *goredis.BoolCmd {
	f.expireCalls++
	f.lastExpireTTL = expiration
	return goredis.NewBoolResult(true, nil)
}

func (f *fakeRedisClient) Persist(context.Context, string) *goredis.BoolCmd {
	return goredis.NewBoolResult(true, nil)
}

func (f *fakeRedisClient) HGetAll(context.Context, string) *goredis.MapStringStringCmd {
	return goredis.NewMapStringStringResult(nil, nil)
}

func (f *fakeRedisClient) HScan(context.Context, string, uint64, string, int64) *goredis.ScanCmd {
	return goredis.NewScanCmdResult(f.hscanPairs, 0, nil)
}

func (f *fakeRedisClient) HLen(context.Context, string) *goredis.IntCmd {
	return goredis.NewIntResult(f.hlenResult, nil)
}

func (f *fakeRedisClient) HSet(context.Context, string, ...any) *goredis.IntCmd {
	return goredis.NewIntResult(1, nil)
}

func (f *fakeRedisClient) HDel(context.Context, string, ...string) *goredis.IntCmd {
	return goredis.NewIntResult(1, nil)
}

func (f *fakeRedisClient) LLen(context.Context, string) *goredis.IntCmd {
	return goredis.NewIntResult(0, nil)
}

func (f *fakeRedisClient) LRange(context.Context, string, int64, int64) *goredis.StringSliceCmd {
	return goredis.NewStringSliceResult(nil, nil)
}

func (f *fakeRedisClient) LSet(context.Context, string, int64, any) *goredis.StatusCmd {
	return goredis.NewStatusResult("OK", nil)
}

func (f *fakeRedisClient) LPush(context.Context, string, ...any) *goredis.IntCmd {
	return goredis.NewIntResult(1, nil)
}

func (f *fakeRedisClient) RPush(context.Context, string, ...any) *goredis.IntCmd {
	return goredis.NewIntResult(1, nil)
}

func (f *fakeRedisClient) LRem(context.Context, string, int64, any) *goredis.IntCmd {
	return goredis.NewIntResult(1, nil)
}

func (f *fakeRedisClient) SCard(context.Context, string) *goredis.IntCmd {
	return goredis.NewIntResult(0, nil)
}

func (f *fakeRedisClient) SScan(context.Context, string, uint64, string, int64) *goredis.ScanCmd {
	return goredis.NewScanCmdResult(nil, 0, nil)
}

func (f *fakeRedisClient) SAdd(context.Context, string, ...any) *goredis.IntCmd {
	return goredis.NewIntResult(1, nil)
}

func (f *fakeRedisClient) SRem(context.Context, string, ...any) *goredis.IntCmd {
	return goredis.NewIntResult(1, nil)
}

func (f *fakeRedisClient) ZCard(context.Context, string) *goredis.IntCmd {
	return goredis.NewIntResult(0, nil)
}

func (f *fakeRedisClient) ZRangeWithScores(context.Context, string, int64, int64) *goredis.ZSliceCmd {
	return goredis.NewZSliceCmdResult(nil, nil)
}

func (f *fakeRedisClient) ZRevRangeWithScores(context.Context, string, int64, int64) *goredis.ZSliceCmd {
	return goredis.NewZSliceCmdResult(nil, nil)
}

func (f *fakeRedisClient) ZAdd(context.Context, string, ...goredis.Z) *goredis.IntCmd {
	return goredis.NewIntResult(1, nil)
}

func (f *fakeRedisClient) ZRem(context.Context, string, ...any) *goredis.IntCmd {
	return goredis.NewIntResult(1, nil)
}

func (f *fakeRedisClient) XRangeN(context.Context, string, string, string, int64) *goredis.XMessageSliceCmd {
	return goredis.NewXMessageSliceCmdResult(f.xRangeMessages, nil)
}

func (f *fakeRedisClient) XRevRangeN(context.Context, string, string, string, int64) *goredis.XMessageSliceCmd {
	return goredis.NewXMessageSliceCmdResult(f.xRevRangeMessages, nil)
}

func (f *fakeRedisClient) XLen(context.Context, string) *goredis.IntCmd {
	return goredis.NewIntResult(0, nil)
}

func (f *fakeRedisClient) XInfoGroups(context.Context, string) *goredis.XInfoGroupsCmd {
	cmd := goredis.NewXInfoGroupsCmd(context.Background(), "stream")
	cmd.SetVal(f.xInfoGroups)
	return cmd
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

	conn := newRedisConnector(fake, nil, config.ConnectionConfig{Host: "cache.example", Port: 6379}, redisSettings{
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

			client, topology, err := newRedisClient(tc.settings, "secret")
			if err != nil {
				t.Fatalf("new redis client: %v", err)
			}
			if client == nil {
				t.Fatalf("expected client")
			}
			if tc.settings.mode == config.RedisModeCluster && topology == nil {
				t.Fatalf("expected cluster topology for cluster mode")
			}
			if tc.settings.mode != config.RedisModeCluster && topology != nil {
				t.Fatalf("expected no cluster topology for mode %q", tc.settings.mode)
			}
			if err := client.Close(); err != nil {
				t.Fatalf("close client: %v", err)
			}
		})
	}
}

func TestRedisListObjectsStandaloneAndSentinelUseSingleScan(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name string
		mode config.RedisMode
	}{
		{name: "standalone", mode: config.RedisModeStandalone},
		{name: "sentinel", mode: config.RedisModeSentinel},
	}

	for _, tc := range tests {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			conn := newRedisConnector(&fakeRedisClient{
				scanClient: &fakeScanClient{
					scanPages: map[string][][]string{
						"*": {{"c:10", "w:1", "w:2"}},
					},
				},
			}, nil, config.ConnectionConfig{}, redisSettings{
				mode:      tc.mode,
				separator: ":",
			})

			objects, err := conn.ListObjects(context.Background(), "")
			if err != nil {
				t.Fatalf("list objects: %v", err)
			}

			got := map[string]int64{}
			for _, object := range objects {
				got[object.Name] = object.RowCount
			}

			if got["c"] != 1 || got["w"] != 2 {
				t.Fatalf("unexpected root objects: %#v", got)
			}
		})
	}
}

func TestRedisListObjectsClusterAggregatesAllMasters(t *testing.T) {
	t.Parallel()

	topology := &fakeClusterTopology{
		masters: []string{"node-a:7000", "node-b:7001"},
		clients: map[string]redisScanClient{
			"node-a:7000": &fakeScanClient{scanPages: map[string][][]string{"*": {{"c:10", "w:1", "w:2"}}}},
			"node-b:7001": &fakeScanClient{scanPages: map[string][][]string{"*": {{"d:1", "h:100", "w:3"}}}},
		},
	}

	conn := newRedisConnector(&fakeRedisClient{}, topology, config.ConnectionConfig{}, redisSettings{
		mode:      config.RedisModeCluster,
		separator: ":",
	})

	objects, err := conn.ListObjects(context.Background(), "")
	if err != nil {
		t.Fatalf("list objects: %v", err)
	}

	got := map[string]int64{}
	for _, object := range objects {
		got[object.Name] = object.RowCount
	}

	if got["c"] != 1 || got["d"] != 1 || got["h"] != 1 || got["w"] != 3 {
		t.Fatalf("unexpected aggregated root objects: %#v", got)
	}
}

func TestRedisListObjectsClusterAggregatesNamespaceChildren(t *testing.T) {
	t.Parallel()

	topology := &fakeClusterTopology{
		masters: []string{"node-a:7000", "node-b:7001"},
		clients: map[string]redisScanClient{
			"node-a:7000": &fakeScanClient{scanPages: map[string][][]string{"w:*": {{"w:1", "w:2"}}}},
			"node-b:7001": &fakeScanClient{scanPages: map[string][][]string{"w:*": {{"w:3"}}}},
		},
	}

	conn := newRedisConnector(&fakeRedisClient{}, topology, config.ConnectionConfig{}, redisSettings{
		mode:      config.RedisModeCluster,
		separator: ":",
	})

	objects, err := conn.ListObjects(context.Background(), "w")
	if err != nil {
		t.Fatalf("list namespace objects: %v", err)
	}

	got := make([]string, 0, len(objects))
	for _, object := range objects {
		got = append(got, object.Name)
	}

	want := []string{"1", "2", "3"}
	if len(got) != len(want) {
		t.Fatalf("unexpected namespace object count: got %v want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("unexpected namespace object order: got %v want %v", got, want)
		}
	}
}

func TestRedisListObjectsClusterDeduplicatesKeys(t *testing.T) {
	t.Parallel()

	topology := &fakeClusterTopology{
		masters: []string{"node-a:7000", "node-b:7001"},
		clients: map[string]redisScanClient{
			"node-a:7000": &fakeScanClient{scanPages: map[string][][]string{"w:*": {{"w:1", "w:2"}}}},
			"node-b:7001": &fakeScanClient{scanPages: map[string][][]string{"w:*": {{"w:1", "w:2", "w:3"}}}},
		},
	}

	conn := newRedisConnector(&fakeRedisClient{}, topology, config.ConnectionConfig{}, redisSettings{
		mode:      config.RedisModeCluster,
		separator: ":",
	})

	objects, err := conn.ListObjects(context.Background(), "w")
	if err != nil {
		t.Fatalf("list namespace objects: %v", err)
	}

	if len(objects) != 3 {
		t.Fatalf("expected deduplicated keys, got %d objects", len(objects))
	}
}

func TestRedisListObjectsClusterAppliesGlobalTruncation(t *testing.T) {
	t.Parallel()

	makeKeys := func(prefix string, count int) []string {
		keys := make([]string, 0, count)
		for i := 0; i < count; i++ {
			keys = append(keys, prefix+":"+strconv.Itoa(i))
		}
		return keys
	}

	topology := &fakeClusterTopology{
		masters: []string{"node-a:7000", "node-b:7001"},
		clients: map[string]redisScanClient{
			"node-a:7000": &fakeScanClient{scanPages: map[string][][]string{"*": {makeKeys("a", 6000)}}},
			"node-b:7001": &fakeScanClient{scanPages: map[string][][]string{"*": {makeKeys("b", 6001)}}},
		},
	}

	conn := newRedisConnector(&fakeRedisClient{}, topology, config.ConnectionConfig{}, redisSettings{
		mode:      config.RedisModeCluster,
		separator: ":",
	})

	objects, err := conn.ListObjects(context.Background(), "")
	if err != nil {
		t.Fatalf("list objects: %v", err)
	}

	var total int64
	for _, object := range objects {
		total += object.RowCount
		if object.Meta["truncated"] != true {
			t.Fatalf("expected truncated meta on %q, got %#v", object.Name, object.Meta)
		}
	}
	if total != int64(maxScanKeys) {
		t.Fatalf("unexpected total key count: got %d want %d", total, maxScanKeys)
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

func TestRedisMutateStringUpdatePreservesTTLByDefault(t *testing.T) {
	t.Parallel()

	fake := &fakeRedisClient{ttlValue: 45 * time.Second}
	conn := newRedisConnector(fake, nil, config.ConnectionConfig{}, redisSettings{
		mode:      config.RedisModeStandalone,
		address:   "cache.example:6379",
		separator: ":",
	})

	result, err := conn.Mutate(context.Background(), connector.MutateOp{
		Type:   "update",
		Object: "cache:key",
		Data:   map[string]any{"value": "updated"},
	})
	if err != nil {
		t.Fatalf("mutate: %v", err)
	}
	if result.RowsAffected != 1 {
		t.Fatalf("unexpected rows affected: %d", result.RowsAffected)
	}
	if fake.setArgsCalls != 1 {
		t.Fatalf("expected SetArgs to preserve TTL, got %d calls", fake.setArgsCalls)
	}
	if fake.lastSetArgs == nil || !fake.lastSetArgs.KeepTTL {
		t.Fatalf("expected KeepTTL=true, got %#v", fake.lastSetArgs)
	}
	if fake.setCalls != 0 {
		t.Fatalf("expected plain Set to be skipped, got %d calls", fake.setCalls)
	}
	if fake.expireCalls != 0 {
		t.Fatalf("expected no explicit TTL rewrite, got %d expire calls", fake.expireCalls)
	}
}

func TestRedisMutateStringUpdateAppliesExplicitTTL(t *testing.T) {
	t.Parallel()

	fake := &fakeRedisClient{}
	conn := newRedisConnector(fake, nil, config.ConnectionConfig{}, redisSettings{
		mode:      config.RedisModeStandalone,
		address:   "cache.example:6379",
		separator: ":",
	})

	result, err := conn.Mutate(context.Background(), connector.MutateOp{
		Type:   "update",
		Object: "cache:key",
		Data: map[string]any{
			"value": "updated",
			"ttl":   int64(60),
		},
	})
	if err != nil {
		t.Fatalf("mutate: %v", err)
	}
	if result.RowsAffected != 1 {
		t.Fatalf("unexpected rows affected: %d", result.RowsAffected)
	}
	if fake.setCalls != 1 {
		t.Fatalf("expected plain Set for explicit TTL override, got %d calls", fake.setCalls)
	}
	if fake.lastSetExpiration != 0 {
		t.Fatalf("expected Set without expiration before applyTTL, got %v", fake.lastSetExpiration)
	}
	if fake.setArgsCalls != 0 {
		t.Fatalf("expected SetArgs to be skipped, got %d calls", fake.setArgsCalls)
	}
	if fake.expireCalls != 1 {
		t.Fatalf("expected explicit Expire call, got %d", fake.expireCalls)
	}
	if fake.lastExpireTTL != 60*time.Second {
		t.Fatalf("unexpected expire ttl: %v", fake.lastExpireTTL)
	}
}

func TestRedisMutateStringUpdateRejectsEmptyPayload(t *testing.T) {
	t.Parallel()

	conn := newRedisConnector(&fakeRedisClient{}, nil, config.ConnectionConfig{}, redisSettings{
		mode:      config.RedisModeStandalone,
		address:   "cache.example:6379",
		separator: ":",
	})

	_, err := conn.Mutate(context.Background(), connector.MutateOp{
		Type:   "update",
		Object: "cache:key",
		Data:   map[string]any{},
	})
	if !errors.Is(err, connector.ErrBadRequest) {
		t.Fatalf("expected bad request, got %v", err)
	}
}
