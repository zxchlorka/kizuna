package config

import (
	"os"
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

func TestLinkConfigCRUDAndPersistence(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.json")
	cfg := &AppConfig{path: path}

	cfg.AddLink(LinkConfig{
		ID:           "lnk-1",
		Name:         "cookie consumer",
		SourceConnID: "kafka-1",
		Topic:        "cookies",
		Field:        "user_id",
		TargetConnID: "redis-1",
		TargetKind:   "redis",
		KeyPattern:   "w:*",
	})

	if got := cfg.GetLinksFor("kafka-1", "cookies"); len(got) != 1 || got[0].ID != "lnk-1" {
		t.Fatalf("GetLinksFor returned %#v", got)
	}
	if got := cfg.GetLinksFor("kafka-1", "other"); len(got) != 0 {
		t.Fatalf("expected no links for other topic, got %#v", got)
	}

	if err := cfg.Save(path); err != nil {
		t.Fatalf("save: %v", err)
	}
	reloaded, err := Load(path)
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	if len(reloaded.GetLinks()) != 1 {
		t.Fatalf("expected 1 link after reload, got %d", len(reloaded.GetLinks()))
	}

	if !cfg.RemoveLink("lnk-1") {
		t.Fatalf("RemoveLink returned false")
	}
	if cfg.RemoveLink("lnk-1") {
		t.Fatalf("RemoveLink returned true for already-removed id")
	}
	if len(cfg.GetLinks()) != 0 {
		t.Fatalf("expected 0 links after remove, got %d", len(cfg.GetLinks()))
	}

	_ = os.Getenv("HOME")
}
