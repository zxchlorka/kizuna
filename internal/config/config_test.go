package config

import (
	"path/filepath"
	"testing"
)

func TestAppConfigRedisRoundTrip(t *testing.T) {
	t.Parallel()

	path := filepath.Join(t.TempDir(), "config.json")
	cfg := &AppConfig{
		Connections: []ConnectionConfig{
			{
				ID:       "redis-1",
				Name:     "redis",
				Type:     "redis",
				Host:     "redis.example",
				Port:     6379,
				Username: "app",
				Password: "encrypted-secret",
				RedisConfig: &RedisConfig{
					Mode:          RedisModeCluster,
					Addresses:     []string{"node1.example:7000", "node2.example:7001"},
					Separator:     "|",
					Database:      4,
					Username:      "acl-user",
					TLSEnabled:    true,
					MasterName:    "unused",
					SentinelAddrs: []string{"sentinel.example:26379"},
				},
			},
		},
		EncryptionKey: "test-key",
	}

	if err := cfg.Save(path); err != nil {
		t.Fatalf("save config: %v", err)
	}

	loaded, err := Load(path)
	if err != nil {
		t.Fatalf("load config: %v", err)
	}

	if len(loaded.Connections) != 1 {
		t.Fatalf("unexpected connections length: %d", len(loaded.Connections))
	}
	got := loaded.Connections[0]
	if got.RedisConfig == nil {
		t.Fatalf("expected redis config to round-trip")
	}
	if got.RedisConfig.Mode != RedisModeCluster {
		t.Fatalf("unexpected redis mode: %q", got.RedisConfig.Mode)
	}
	if len(got.RedisConfig.Addresses) != 2 {
		t.Fatalf("unexpected cluster addresses: %#v", got.RedisConfig.Addresses)
	}
	if got.RedisConfig.Separator != "|" {
		t.Fatalf("unexpected separator: %q", got.RedisConfig.Separator)
	}
	if !got.RedisConfig.TLSEnabled {
		t.Fatalf("expected tls to round-trip")
	}
}
