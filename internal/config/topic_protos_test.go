package config

import (
	"path/filepath"
	"testing"
)

func TestTopicProtos(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.json")
	cfg := &AppConfig{path: path}
	cfg.AddConnection(ConnectionConfig{ID: "kafka-1", Type: "kafka"})
	cfg.AddConnection(ConnectionConfig{ID: "kafka-2", Type: "kafka"})

	cfg.SetTopicProto(TopicProtoConfig{ConnID: "kafka-1", Topic: "events", FileName: "a.proto", Source: "v1", Message: "demo.A"})
	cfg.SetTopicProto(TopicProtoConfig{ConnID: "kafka-2", Topic: "events", FileName: "b.proto", Source: "v1", Message: "demo.B"})
	// Setting it again replaces the topic's contract rather than adding one.
	cfg.SetTopicProto(TopicProtoConfig{ConnID: "kafka-1", Topic: "events", FileName: "a.proto", Source: "v2", Message: "demo.A2"})

	if err := cfg.Save(path); err != nil {
		t.Fatalf("save: %v", err)
	}
	reloaded, err := Load(path)
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	got, ok := reloaded.GetTopicProto("kafka-1", "events")
	if !ok || got.Source != "v2" || got.Message != "demo.A2" {
		t.Fatalf("kafka-1 events = %+v, %v", got, ok)
	}
	if _, ok := reloaded.GetTopicProto("kafka-1", "other"); ok {
		t.Fatal("a topic without a contract reported one")
	}

	if !reloaded.RemoveTopicProto("kafka-1", "events") || reloaded.RemoveTopicProto("kafka-1", "events") {
		t.Fatal("remove should report true once, then false")
	}
	if _, ok := reloaded.GetTopicProto("kafka-1", "events"); ok {
		t.Fatal("removed contract is still there")
	}

	// Deleting a connection takes its contracts with it.
	reloaded.RemoveConnectionCascade("kafka-2")
	if _, ok := reloaded.GetTopicProto("kafka-2", "events"); ok {
		t.Fatal("contract outlived its connection")
	}
}
