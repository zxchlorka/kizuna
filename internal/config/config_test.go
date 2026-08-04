package config

import (
	"os"
	"path/filepath"
	"testing"
)

func TestUpdateLink(t *testing.T) {
	cfg := &AppConfig{}
	cfg.AddLink(LinkConfig{
		ID: "lnk-1", SourceConnID: "kafka-1", SourceKind: "kafka",
		SourceScope: "cookies", SourceField: "user_id",
		TargetConnID: "redis-1", TargetKind: "redis", KeyPattern: "w:*",
	})

	ok := cfg.UpdateLink("lnk-1", LinkConfig{
		SourceConnID: "kafka-1", SourceKind: "kafka",
		SourceScope: "cookies", SourceField: "uid",
		TargetConnID: "redis-1", TargetKind: "redis", KeyPattern: "c:*",
	})
	if !ok {
		t.Fatalf("UpdateLink returned false for existing id")
	}
	got := cfg.GetLinks()
	if len(got) != 1 || got[0].ID != "lnk-1" || got[0].SourceField != "uid" || got[0].KeyPattern != "c:*" {
		t.Fatalf("UpdateLink did not replace fields / preserve id: %#v", got)
	}
	if cfg.UpdateLink("nope", LinkConfig{}) {
		t.Fatalf("UpdateLink returned true for unknown id")
	}
}

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

func TestAppConfigKafkaTLSCARoundTrip(t *testing.T) {
	t.Parallel()

	path := filepath.Join(t.TempDir(), "config.json")
	const caPEM = "-----BEGIN CERTIFICATE-----\nexample\n-----END CERTIFICATE-----"
	cfg := &AppConfig{
		Connections: []ConnectionConfig{
			{
				ID:   "kafka-1",
				Name: "production kafka",
				Type: "kafka",
				KafkaConfig: &KafkaConfig{
					Brokers:       []string{"broker.example:9094"},
					SASLMechanism: KafkaSASLScramSHA256,
					TLSEnabled:    true,
					TLSCAPEM:      caPEM,
				},
			},
		},
	}

	if err := cfg.Save(path); err != nil {
		t.Fatalf("save config: %v", err)
	}

	loaded, err := Load(path)
	if err != nil {
		t.Fatalf("load config: %v", err)
	}
	got, ok := loaded.GetConnection("kafka-1")
	if !ok || got.KafkaConfig == nil {
		t.Fatal("expected kafka config to round-trip")
	}
	if got.KafkaConfig.TLSCAPEM != caPEM {
		t.Fatalf("unexpected TLS CA PEM: %q", got.KafkaConfig.TLSCAPEM)
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

func TestLinkBackwardCompatAndScopeMatch(t *testing.T) {
	cfg := &AppConfig{
		Links: []LinkConfig{
			{ID: "v1", SourceConnID: "k1", Topic: "cookies", Field: "user_id", TargetConnID: "r1", TargetKind: "redis", KeyPattern: "w:*"},
			{ID: "v2", SourceConnID: "r1", SourceKind: "redis", SourceScope: "profile:*", SourceExtract: "value_field", SourceField: "user_id", TargetConnID: "k1", TargetKind: "kafka", TargetTopic: "cookies", TargetField: "user_id"},
		},
	}

	kafkaLinks := cfg.GetLinksFor("k1", "cookies")
	if len(kafkaLinks) != 1 || kafkaLinks[0].SourceKind != "kafka" || kafkaLinks[0].SourceScope != "cookies" || kafkaLinks[0].SourceField != "user_id" {
		t.Fatalf("v1 link not normalized to kafka source: %#v", kafkaLinks)
	}

	redisLinks := cfg.GetLinksFor("r1", "profile:123123")
	if len(redisLinks) != 1 || redisLinks[0].ID != "v2" {
		t.Fatalf("expected redis pattern scope match, got %#v", redisLinks)
	}
	if got := cfg.GetLinksFor("r1", "other:1"); len(got) != 0 {
		t.Fatalf("expected no match for non-matching key, got %#v", got)
	}
}

// TestRemoveConnectionCascade covers the cascade contract from the
// 2026-07-21 plan: deleting a connection must remove every link where it is the
// source OR the target, in a single config mutation, without touching unrelated
// links. Orphaned links with a dangling source_conn_id/target_conn_id were
// previously persisted forever because RemoveConnection only filtered
// Connections.
func TestRemoveConnectionCascade(t *testing.T) {
	link := func(id, source, target string) LinkConfig {
		return LinkConfig{
			ID: id, SourceConnID: source, SourceKind: "kafka", SourceScope: "topic",
			SourceField: "user_id", TargetConnID: target, TargetKind: "redis", KeyPattern: "w:*",
		}
	}

	tests := []struct {
		name          string
		links         []LinkConfig
		remove        string
		wantRemoved   bool
		wantLinkIDs   []string // links that must REMAIN, in order
		wantRemovedID []string // link ids the call must report as removed
	}{
		{
			name:          "connection used only as source",
			links:         []LinkConfig{link("l1", "conn-a", "conn-b"), link("l2", "conn-c", "conn-d")},
			remove:        "conn-a",
			wantRemoved:   true,
			wantLinkIDs:   []string{"l2"},
			wantRemovedID: []string{"l1"},
		},
		{
			name:          "connection used only as target",
			links:         []LinkConfig{link("l1", "conn-a", "conn-b"), link("l2", "conn-c", "conn-d")},
			remove:        "conn-b",
			wantRemoved:   true,
			wantLinkIDs:   []string{"l2"},
			wantRemovedID: []string{"l1"},
		},
		{
			name:          "connection on both sides of different links",
			links:         []LinkConfig{link("l1", "conn-a", "conn-b"), link("l2", "conn-c", "conn-a"), link("l3", "conn-c", "conn-d")},
			remove:        "conn-a",
			wantRemoved:   true,
			wantLinkIDs:   []string{"l3"},
			wantRemovedID: []string{"l1", "l2"},
		},
		{
			name:          "self link removed exactly once",
			links:         []LinkConfig{link("l1", "conn-a", "conn-a"), link("l2", "conn-c", "conn-d")},
			remove:        "conn-a",
			wantRemoved:   true,
			wantLinkIDs:   []string{"l2"},
			wantRemovedID: []string{"l1"},
		},
		{
			name:          "connection with no links",
			links:         []LinkConfig{link("l1", "conn-c", "conn-d")},
			remove:        "conn-a",
			wantRemoved:   true,
			wantLinkIDs:   []string{"l1"},
			wantRemovedID: nil,
		},
		{
			name:          "unknown connection removes nothing",
			links:         []LinkConfig{link("l1", "conn-a", "conn-b")},
			remove:        "conn-missing",
			wantRemoved:   false,
			wantLinkIDs:   []string{"l1"},
			wantRemovedID: nil,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			cfg := &AppConfig{}
			// Every connection referenced by the fixtures exists, plus the one the
			// "no links" case deletes.
			for _, id := range []string{"conn-a", "conn-b", "conn-c", "conn-d"} {
				cfg.AddConnection(ConnectionConfig{ID: id, Name: id, Type: "redis"})
			}
			for _, l := range tt.links {
				cfg.AddLink(l)
			}

			removed, removedLinkIDs := cfg.RemoveConnectionCascade(tt.remove)

			if removed != tt.wantRemoved {
				t.Fatalf("removed = %v, want %v", removed, tt.wantRemoved)
			}
			if len(removedLinkIDs) != len(tt.wantRemovedID) {
				t.Fatalf("removedLinkIDs = %v, want %v", removedLinkIDs, tt.wantRemovedID)
			}
			for i, want := range tt.wantRemovedID {
				if removedLinkIDs[i] != want {
					t.Fatalf("removedLinkIDs = %v, want %v", removedLinkIDs, tt.wantRemovedID)
				}
			}

			gotLinks := cfg.GetLinks()
			if len(gotLinks) != len(tt.wantLinkIDs) {
				t.Fatalf("remaining links = %d %v, want %v", len(gotLinks), gotLinks, tt.wantLinkIDs)
			}
			for i, want := range tt.wantLinkIDs {
				if gotLinks[i].ID != want {
					t.Fatalf("remaining link[%d].ID = %q, want %q", i, gotLinks[i].ID, want)
				}
			}
			if tt.wantRemoved {
				if _, ok := cfg.GetConnection(tt.remove); ok {
					t.Fatalf("connection %q still present after cascade", tt.remove)
				}
			}
		})
	}
}

// TestRemoveConnectionCascadePersists proves the cascade survives a save/load
// round trip — the original defect was that orphan links came back from disk.
func TestRemoveConnectionCascadePersists(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.json")
	cfg := &AppConfig{path: path}
	cfg.AddConnection(ConnectionConfig{ID: "redis-1", Name: "redis", Type: "redis"})
	cfg.AddConnection(ConnectionConfig{ID: "kafka-1", Name: "kafka", Type: "kafka"})
	cfg.AddLink(LinkConfig{ID: "l1", SourceConnID: "kafka-1", SourceKind: "kafka", TargetConnID: "redis-1", TargetKind: "redis", KeyPattern: "w:*"})
	cfg.AddLink(LinkConfig{ID: "l2", SourceConnID: "redis-1", SourceKind: "redis", TargetConnID: "kafka-1", TargetKind: "kafka", TargetTopic: "events"})

	removed, removedLinkIDs := cfg.RemoveConnectionCascade("redis-1")
	if !removed || len(removedLinkIDs) != 2 {
		t.Fatalf("cascade removed=%v links=%v, want true and 2 links", removed, removedLinkIDs)
	}
	if err := cfg.Save(path); err != nil {
		t.Fatalf("save: %v", err)
	}

	reloaded, err := Load(path)
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	if got := reloaded.GetLinks(); len(got) != 0 {
		t.Fatalf("orphan links came back from disk: %#v", got)
	}
	if got := reloaded.GetConnections(); len(got) != 1 || got[0].ID != "kafka-1" {
		t.Fatalf("unexpected connections after reload: %#v", got)
	}
}
