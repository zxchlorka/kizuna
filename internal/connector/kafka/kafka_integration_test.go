package kafka

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"testing"
	"time"

	"github.com/twmb/franz-go/pkg/kadm"
	"github.com/twmb/franz-go/pkg/kgo"
	"github.com/zxchlorka/kizuna/internal/config"
	"github.com/zxchlorka/kizuna/internal/connector"
)

func TestKafkaMessageBrowseAndNestedSearchIntegration(t *testing.T) {
	broker := os.Getenv("KAFKA_TEST_BROKER")
	if broker == "" {
		t.Skip("set KAFKA_TEST_BROKER to run the local Kafka integration test")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()

	seedClient, err := kgo.NewClient(
		kgo.SeedBrokers(broker),
		kgo.RecordPartitioner(kgo.ManualPartitioner()),
	)
	if err != nil {
		t.Fatalf("create seed client: %v", err)
	}
	defer seedClient.Close()

	topic := fmt.Sprintf("kizuna-message-qa-%d", time.Now().UnixNano())
	admin := kadm.NewClient(seedClient)
	created, err := admin.CreateTopics(ctx, 54, 1, nil, topic)
	if err != nil {
		t.Fatalf("create topic: %v", err)
	}
	if response := created[topic]; response.Err != nil {
		t.Fatalf("create topic response: %v", response.Err)
	}
	t.Cleanup(func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cleanupCancel()
		_, _ = admin.DeleteTopics(cleanupCtx, topic)
	})

	baseTime := time.Date(2026, time.July, 20, 12, 0, 0, 0, time.UTC)
	authPayload := integrationAuthPayload(t)
	records := make([]*kgo.Record, 0, 54*12+60)
	for partition := int32(0); partition < 54; partition++ {
		for index := 0; index < 12; index++ {
			value := []byte(`{"src":{"event_data":{"events":[{"name":"View"}]}}}`)
			if partition == 53 && index == 11 {
				value = authPayload
			}
			records = append(records, &kgo.Record{
				Topic:     topic,
				Partition: partition,
				Timestamp: baseTime.Add(time.Duration(int(partition)*12+index) * time.Millisecond),
				Value:     value,
			})
		}
	}
	// A newer burst exists only in one partition. The fast snapshot reader must
	// represent that partition in the first page without letting it dominate:
	// the page is a recent cross-partition snapshot, not an exact global top-N.
	for index := 0; index < 60; index++ {
		records = append(records, &kgo.Record{
			Topic:     topic,
			Partition: 0,
			Timestamp: baseTime.Add(time.Second + time.Duration(index)*time.Millisecond),
			Value:     []byte(`{"src":{"event_data":{"events":[{"name":"Burst"}]}}}`),
		})
	}
	if err := seedClient.ProduceSync(ctx, records...).FirstErr(); err != nil {
		t.Fatalf("produce fixtures: %v", err)
	}

	conn, err := New(ctx, config.ConnectionConfig{
		Type:        "kafka",
		KafkaConfig: &config.KafkaConfig{Brokers: []string{broker}},
	}, "")
	if err != nil {
		t.Fatalf("create connector: %v", err)
	}
	defer conn.Close()

	firstStart := time.Now()
	first, err := conn.GetData(ctx, topic, connector.DataOpts{Limit: 100})
	firstElapsed := time.Since(firstStart)
	if err != nil {
		t.Fatalf("first page: %v", err)
	}
	t.Logf(
		"timing call=first_page elapsed_ms=%d rows=%d partitions_total=%v partitions_completed=%v "+
			"has_older=%v partial=%v candidates_read=%v messages_returned=%v meta_elapsed_ms=%v next_before_offsets_count=%d",
		firstElapsed.Milliseconds(), len(first.Rows), first.Meta["partitions_total"], first.Meta["partitions_completed"],
		first.Meta["has_older"], first.Meta["partial"], first.Meta["candidates_read"], first.Meta["messages_returned"],
		first.Meta["elapsed_ms"], len(cursorMap(first.Meta["next_before_offsets"])),
	)
	// Task 3's response-contract meta fields must all be present with sane
	// values for a full-success normal-browse page: every scoped partition (54,
	// no partition filter) responded, none partial, and messages_returned
	// matches the actual row count.
	if got, want := first.Meta["partitions_total"], 54; got != want {
		t.Fatalf("meta.partitions_total = %v, want %d", got, want)
	}
	if got, want := first.Meta["partitions_completed"], 54; got != want {
		t.Fatalf("meta.partitions_completed = %v, want %d (a fast local broker should complete every partition)", got, want)
	}
	if partial, _ := first.Meta["partial"].(bool); partial {
		t.Fatalf("meta.partial = true unexpectedly: %#v", first.Meta)
	}
	if _, hasReason := first.Meta["partial_reason"]; hasReason {
		t.Fatalf("meta.partial_reason must be absent when partial=false, got %v", first.Meta["partial_reason"])
	}
	if got, want := first.Meta["messages_returned"], len(first.Rows); got != want {
		t.Fatalf("meta.messages_returned = %v, want %d (len(Rows))", got, want)
	}
	candidatesRead, ok := first.Meta["candidates_read"].(int)
	if !ok || candidatesRead < len(first.Rows) {
		t.Fatalf("meta.candidates_read = %#v, want an int >= messages_returned (%d)", first.Meta["candidates_read"], len(first.Rows))
	}
	elapsedMetaMs, ok := first.Meta["elapsed_ms"].(int64)
	if !ok || elapsedMetaMs < 0 {
		t.Fatalf("meta.elapsed_ms = %#v, want a non-negative int64", first.Meta["elapsed_ms"])
	}
	// Fast snapshot semantics: the page is a bounded recent snapshot, not exact
	// global top-N. Expect 50-100 recent records, not a page filled entirely by
	// the burst partition.
	if len(first.Rows) < 50 || len(first.Rows) > 100 {
		t.Fatalf("first page returned %d messages, want a 50-100 recent snapshot", len(first.Rows))
	}
	// The burst partition must be represented in the snapshot, but need not fill
	// the whole page.
	burstRepresented := false
	for _, row := range first.Rows {
		if partition, _ := row["partition"].(int32); partition == 0 {
			burstRepresented = true
			break
		}
	}
	if !burstRepresented {
		t.Fatal("first page does not represent the burst partition (partition 0) in the snapshot")
	}
	// The response must be bounded in time: it returns near the reader budget
	// rather than waiting out every slow partition (well under the 45s ctx).
	if firstElapsed > 10*time.Second {
		t.Fatalf("first page took %v, want a time-bounded fast snapshot", firstElapsed)
	}

	cursor, ok := first.Meta["next_before_offsets"].(map[string]int64)
	if !ok || len(cursor) == 0 {
		t.Fatalf("first page missing cursor: %#v", first.Meta)
	}
	cursorJSON, err := json.Marshal(cursor)
	if err != nil {
		t.Fatalf("marshal cursor: %v", err)
	}
	secondStart := time.Now()
	second, err := conn.GetData(ctx, topic, connector.DataOpts{
		Limit: 100,
		Filters: []connector.FilterExpr{{
			Column: "before_offsets",
			Op:     "eq",
			Value:  string(cursorJSON),
		}},
	})
	secondElapsed := time.Since(secondStart)
	if err != nil {
		t.Fatalf("second page: %v", err)
	}
	t.Logf(
		"timing call=second_page elapsed_ms=%d rows=%d partitions_total=%v partitions_completed=%v "+
			"has_older=%v partial=%v candidates_read=%v messages_returned=%v next_before_offsets_count=%d",
		secondElapsed.Milliseconds(), len(second.Rows), second.Meta["partitions_total"], second.Meta["partitions_completed"],
		second.Meta["has_older"], second.Meta["partial"], second.Meta["candidates_read"], second.Meta["messages_returned"],
		len(cursorMap(second.Meta["next_before_offsets"])),
	)
	// A second recent snapshot below the first page's cursor. Bounded, non-empty.
	if len(second.Rows) == 0 || len(second.Rows) > 100 {
		t.Fatalf("second page returned %d messages, want a bounded non-empty snapshot", len(second.Rows))
	}
	if secondElapsed > 10*time.Second {
		t.Fatalf("second page took %v, want a time-bounded fast snapshot", secondElapsed)
	}
	// Pagination must stay lossless: no (partition, offset) identity may repeat
	// across pages.
	seen := make(map[string]struct{}, len(first.Rows))
	for _, row := range first.Rows {
		seen[rowIdentity(row)] = struct{}{}
	}
	for _, row := range second.Rows {
		if _, duplicate := seen[rowIdentity(row)]; duplicate {
			t.Fatalf("pagination returned duplicate message %s", rowIdentity(row))
		}
	}

	searchStart := time.Now()
	search, err := conn.GetData(ctx, topic, connector.DataOpts{
		Limit: 50,
		Filters: []connector.FilterExpr{
			{Column: "match_field", Op: "eq", Value: "events[].name"},
			{Column: "match_value", Op: "eq", Value: "Auth"},
		},
	})
	searchElapsed := time.Since(searchStart)
	if err != nil {
		t.Fatalf("nested search: %v", err)
	}
	t.Logf(
		"timing call=nested_search elapsed_ms=%d rows=%d partitions_total=%v partitions_completed=%v "+
			"has_older=%v scanned=%v matched=%v partial_scan=%v candidates_read=%v",
		searchElapsed.Milliseconds(), len(search.Rows), search.Meta["partitions_total"], search.Meta["partitions_completed"],
		search.Meta["has_older"], search.Meta["scanned"], search.Meta["matched"], search.Meta["partial_scan"],
		search.Meta["candidates_read"],
	)
	if len(search.Rows) != 1 {
		t.Fatalf("nested search returned %d matches, want 1", len(search.Rows))
	}
	if !messageMatchesField(search.Rows[0], "src.event_data.events[].name", "Auth") {
		t.Fatal("nested search returned the wrong message")
	}
}

// integrationAuthPayload optionally uses a real message fixture. The test
// rewrites only the first events[].name value and never mutates the source file.
func integrationAuthPayload(t *testing.T) []byte {
	t.Helper()

	path := os.Getenv("KAFKA_TEST_MESSAGE_FILE")
	if path == "" {
		return []byte(`{"src":{"event_data":{"events":[{"name":"Auth"}]}}}`)
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read message fixture: %v", err)
	}
	var payload map[string]any
	if err := json.Unmarshal(raw, &payload); err != nil {
		t.Fatalf("parse message fixture: %v", err)
	}
	src, ok := payload["src"].(map[string]any)
	if !ok {
		t.Fatal("message fixture missing src object")
	}
	eventData, ok := src["event_data"].(map[string]any)
	if !ok {
		t.Fatal("message fixture missing src.event_data object")
	}
	events, ok := eventData["events"].([]any)
	if !ok || len(events) == 0 {
		t.Fatal("message fixture missing src.event_data.events array")
	}
	first, ok := events[0].(map[string]any)
	if !ok {
		t.Fatal("message fixture first event is not an object")
	}
	first["name"] = "Auth"
	updated, err := json.Marshal(payload)
	if err != nil {
		t.Fatalf("encode message fixture: %v", err)
	}
	return updated
}

func rowIdentity(row map[string]any) string {
	return fmt.Sprintf("%v:%v", row["partition"], row["offset"])
}

// cursorMap safely reads meta["next_before_offsets"] for logging only; it
// never fails the test, since its sole purpose here is a candidate/partition-
// completion signal alongside timing output.
func cursorMap(value any) map[string]int64 {
	cursor, _ := value.(map[string]int64)
	return cursor
}
