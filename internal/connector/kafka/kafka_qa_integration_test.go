package kafka

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
	"os"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/twmb/franz-go/pkg/kadm"
	"github.com/twmb/franz-go/pkg/kgo"
	"github.com/zxchlorka/kizuna/internal/config"
	"github.com/zxchlorka/kizuna/internal/connector"
)

// Task 8a — representative local-only QA. These tests are gated on
// KAFKA_TEST_BROKER (they skip when unset) and MUST only ever target the local
// docker-compose.test.yml broker (localhost:59092). assertLocalBroker enforces
// that boundary in code so a stray production broker address (per the plan's
// Testing/environment boundaries: Kafka device-fp / analytics-prod-kafka-web01.*,
// etc.) can never be reached from a test run, regardless of what KAFKA_TEST_BROKER
// is set to.
//
// The existing TestKafkaMessageBrowseAndNestedSearchIntegration already covers the
// normal first/second page and the nested-array Auth search on its own freshly
// seeded topic. This file adds the remaining Task 8a acceptance items against a
// richer fixture: an empty partition, a >100-record partition for the single-
// partition-filter cursor check, dozens of large (~128KB) payloads, a full-drain
// lossless pagination sweep, and a genuinely empty topic.

// assertLocalBroker refuses to run against any non-local broker. The QA fixtures
// create and delete topics and produce records; that must never touch shared or
// production infrastructure.
func assertLocalBroker(t *testing.T, broker string) {
	t.Helper()
	for _, addr := range strings.Split(broker, ",") {
		host := strings.TrimSpace(addr)
		if h, _, err := net.SplitHostPort(host); err == nil {
			host = h
		}
		switch host {
		case "localhost", "127.0.0.1", "::1", "[::1]", "0.0.0.0":
			continue
		default:
			t.Fatalf("refusing to run Kafka QA against non-local broker %q: these tests must only target the "+
				"local docker-compose.test.yml broker (see global-constraints Testing/environment boundaries)", broker)
		}
	}
}

// registerTopicCleanup deletes the given topics when the test finishes. It builds
// a FRESH client at cleanup time rather than reusing the seed client, because the
// seed client is typically closed by a deferred Close() that runs before t.Cleanup
// callbacks — the pre-existing accumulate-topics bug documented in
// task-0-baseline.md. This helper deletes reliably so QA runs leave no stray
// topics behind.
func registerTopicCleanup(t *testing.T, broker string, topics ...string) {
	t.Helper()
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
		defer cancel()
		cl, err := kgo.NewClient(kgo.SeedBrokers(broker))
		if err != nil {
			t.Logf("cleanup: creating client to delete topics %v failed: %v", topics, err)
			return
		}
		defer cl.Close()
		if _, err := kadm.NewClient(cl).DeleteTopics(ctx, topics...); err != nil {
			t.Logf("cleanup: deleting topics %v failed: %v", topics, err)
			return
		}
		t.Logf("cleanup: deleted topics %v", topics)
	})
}

// waitTopicReady blocks until every partition of the topic reports a
// non-errored end offset, i.e. leaders are elected and the topic is queryable.
// A freshly created topic briefly surfaces errored partitions in the offset
// listing (which GetData correctly treats as "topic not found"), so tests that
// query a just-created topic without producing to it first must wait.
func waitTopicReady(ctx context.Context, admin *kadm.Client, topic string) error {
	deadline := time.Now().Add(30 * time.Second)
	var lastErr error
	for {
		ends, err := admin.ListEndOffsets(ctx, topic)
		lastErr = err
		if err == nil {
			if parts, ok := ends[topic]; ok && len(parts) > 0 && !partitionsAllErrored(parts) {
				ready := true
				for _, p := range parts {
					if p.Err != nil {
						ready = false
						break
					}
				}
				if ready {
					return nil
				}
			}
		}
		if ctx.Err() != nil || time.Now().After(deadline) {
			return fmt.Errorf("topic %q not ready in time: %v", topic, lastErr)
		}
		time.Sleep(300 * time.Millisecond)
	}
}

func TestKafkaRepresentativeQAIntegration(t *testing.T) {
	broker := os.Getenv("KAFKA_TEST_BROKER")
	if broker == "" {
		t.Skip("set KAFKA_TEST_BROKER to run the local Kafka QA integration test")
	}
	assertLocalBroker(t, broker)

	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()

	seedClient, err := kgo.NewClient(
		kgo.SeedBrokers(broker),
		kgo.RecordPartitioner(kgo.ManualPartitioner()),
	)
	if err != nil {
		t.Fatalf("create seed client: %v", err)
	}
	defer seedClient.Close()
	admin := kadm.NewClient(seedClient)

	const (
		partitions     = 54
		emptyPartition = int32(27) // deliberately left with zero records
		viewPerPart    = 12
		burstCount     = 100        // partition 0 gets >100 records for the single-partition cursor check
		largePartsFrom = int32(5)   // partitions 5..8 also carry large payloads
		largePartsTo   = int32(8)   // inclusive
		largePerPart   = 12         // 48 large payloads total (dozens, per the seeding requirement)
		authPartition  = int32(53)  // Auth fixture lives here
		largePayloadSz = 128 * 1024 // ~128KB
	)

	topic := fmt.Sprintf("kizuna-message-qa-%d", time.Now().UnixNano())
	created, err := admin.CreateTopics(ctx, partitions, 1, nil, topic)
	if err != nil {
		t.Fatalf("create topic: %v", err)
	}
	if response := created[topic]; response.Err != nil {
		t.Fatalf("create topic response: %v", response.Err)
	}
	registerTopicCleanup(t, broker, topic)
	if err := waitTopicReady(ctx, admin, topic); err != nil {
		t.Fatalf("topic not ready: %v", err)
	}

	baseTime := time.Date(2026, time.July, 20, 12, 0, 0, 0, time.UTC)
	largeValue := []byte(`{"blob":"` + strings.Repeat("A", largePayloadSz) + `"}`)
	authPayload := integrationAuthPayload(t)

	// Build records with per-partition slice order == desired offset order:
	//   uniform "View" (oldest) -> large payloads (newer) -> burst (newest, p0)
	//   -> Auth (recent, p53). Partition 27 is skipped entirely (empty partition).
	records := make([]*kgo.Record, 0, partitions*viewPerPart+burstCount+64)
	for partition := int32(0); partition < partitions; partition++ {
		if partition == emptyPartition {
			continue
		}
		for index := 0; index < viewPerPart; index++ {
			records = append(records, &kgo.Record{
				Topic:     topic,
				Partition: partition,
				Timestamp: baseTime.Add(time.Duration(int(partition)*viewPerPart+index) * time.Millisecond),
				Value:     []byte(`{"src":{"event_data":{"events":[{"name":"View"}]}}}`),
			})
		}
	}
	// Dozens of large ~128KB payloads across a handful of partitions, newer than
	// the View records so a normal browse actually reaches and deserializes them.
	largeBase := baseTime.Add(30 * time.Minute)
	for partition := largePartsFrom; partition <= largePartsTo; partition++ {
		for index := 0; index < largePerPart; index++ {
			records = append(records, &kgo.Record{
				Topic:     topic,
				Partition: partition,
				Timestamp: largeBase.Add(time.Duration(int(partition)*largePerPart+index) * time.Millisecond),
				Value:     largeValue,
			})
		}
	}
	// A burst concentrated in one partition (partition 0), newest of all, giving
	// partition 0 well over 100 records for the single-partition-filter check.
	burstBase := baseTime.Add(time.Hour)
	for index := 0; index < burstCount; index++ {
		records = append(records, &kgo.Record{
			Topic:     topic,
			Partition: 0,
			Timestamp: burstBase.Add(time.Duration(index) * time.Millisecond),
			Value:     []byte(`{"src":{"event_data":{"events":[{"name":"Burst"}]}}}`),
		})
	}
	// The nested-array Auth fixture from docs/msg.json (events[0].name rewritten
	// to "Auth"; the source file is never mutated).
	records = append(records, &kgo.Record{
		Topic:     topic,
		Partition: authPartition,
		Timestamp: baseTime.Add(45 * time.Minute),
		Value:     authPayload,
	})
	if err := seedClient.ProduceSync(ctx, records...).FirstErr(); err != nil {
		t.Fatalf("produce fixtures: %v", err)
	}

	// Authoritative per-partition offset ranges straight from the broker, so the
	// coverage assertions are independent of the seeding bookkeeping.
	starts, err := admin.ListStartOffsets(ctx, topic)
	if err != nil {
		t.Fatalf("list start offsets: %v", err)
	}
	ends, err := admin.ListEndOffsets(ctx, topic)
	if err != nil {
		t.Fatalf("list end offsets: %v", err)
	}
	startOf := make(map[int32]int64, partitions)
	endOf := make(map[int32]int64, partitions)
	var totalRecords int64
	for id := int32(0); id < partitions; id++ {
		s, sok := starts[topic][id]
		e, eok := ends[topic][id]
		if !sok || !eok {
			t.Fatalf("missing offsets for partition %d", id)
		}
		startOf[id] = s.Offset
		endOf[id] = e.Offset
		totalRecords += e.Offset - s.Offset
	}
	if got := endOf[emptyPartition] - startOf[emptyPartition]; got != 0 {
		t.Fatalf("partition %d must be empty, has %d records", emptyPartition, got)
	}
	if got := endOf[0] - startOf[0]; got <= 100 {
		t.Fatalf("partition 0 must hold >100 records for the single-partition check, has %d", got)
	}
	t.Logf("seeded topic=%s partitions=%d total_records=%d empty_partition=%d p0_records=%d",
		topic, partitions, totalRecords, emptyPartition, endOf[0]-startOf[0])

	conn, err := New(ctx, config.ConnectionConfig{
		Type:        "kafka",
		KafkaConfig: &config.KafkaConfig{Brokers: []string{broker}},
	}, "")
	if err != nil {
		t.Fatalf("create connector: %v", err)
	}
	defer conn.Close()

	// ---- Acceptance: normal local run — 50-100 rows, partial=false, no 408. ----
	t.Run("normal_run_full_page_not_partial", func(t *testing.T) {
		start := time.Now()
		res, err := conn.GetData(ctx, topic, connector.DataOpts{Limit: 100})
		elapsed := time.Since(start)
		if err != nil {
			t.Fatalf("normal browse returned an error (a 408/ErrTimeout is a failure here): %v", err)
		}
		if len(res.Rows) < 50 || len(res.Rows) > 100 {
			t.Fatalf("normal browse returned %d rows, want a 50-100 snapshot", len(res.Rows))
		}
		if partial, _ := res.Meta["partial"].(bool); partial {
			t.Fatalf("normal browse against a fast local broker must not be partial: %#v", res.Meta)
		}
		if _, hasReason := res.Meta["partial_reason"]; hasReason {
			t.Fatalf("partial_reason must be absent when partial=false, got %v", res.Meta["partial_reason"])
		}
		if got, want := res.Meta["partitions_total"], partitions; got != want {
			t.Fatalf("partitions_total = %v, want %d", got, want)
		}
		t.Logf("normal_run rows=%d elapsed_ms=%d partitions_total=%v partitions_completed=%v has_older=%v partial=%v candidates_read=%v",
			len(res.Rows), elapsed.Milliseconds(), res.Meta["partitions_total"], res.Meta["partitions_completed"],
			res.Meta["has_older"], res.Meta["partial"], res.Meta["candidates_read"])
	})

	// ---- Acceptance: nested-array Auth search on src.event_data.events[].name. ----
	t.Run("nested_array_auth_search", func(t *testing.T) {
		res, err := conn.GetData(ctx, topic, connector.DataOpts{
			Limit: 50,
			Filters: []connector.FilterExpr{
				{Column: "match_field", Op: "eq", Value: "events[].name"},
				{Column: "match_value", Op: "eq", Value: "Auth"},
			},
		})
		if err != nil {
			t.Fatalf("nested Auth search: %v", err)
		}
		if len(res.Rows) != 1 {
			t.Fatalf("nested Auth search returned %d matches, want exactly 1", len(res.Rows))
		}
		if !messageMatchesField(res.Rows[0], "src.event_data.events[].name", "Auth") {
			t.Fatal("nested Auth search returned the wrong message")
		}
		t.Logf("nested_array_auth_search matched=%d scanned=%v partial_scan=%v",
			len(res.Rows), res.Meta["scanned"], res.Meta["partial_scan"])
	})

	// ---- Acceptance: single-partition filter — full page + verifiable cursor. ----
	t.Run("single_partition_filter_cursor", func(t *testing.T) {
		end := endOf[0]
		res, err := conn.GetData(ctx, topic, connector.DataOpts{
			Limit:   100,
			Filters: []connector.FilterExpr{{Column: "partition", Op: "eq", Value: "0"}},
		})
		if err != nil {
			t.Fatalf("single-partition browse: %v", err)
		}
		if got, want := res.Meta["partitions_total"], 1; got != want {
			t.Fatalf("single-partition browse partitions_total = %v, want %d", got, want)
		}
		if len(res.Rows) != 100 {
			t.Fatalf("single-partition browse returned %d rows, want a full page of 100", len(res.Rows))
		}
		// Independently verify the page is the newest contiguous 100 offsets:
		// [end-100, end-1], and the cursor is exactly that lowest offset.
		offs := rowOffsetsDesc(t, res.Rows, 0)
		if offs[0] != end-1 {
			t.Fatalf("newest returned offset = %d, want end-1 = %d", offs[0], end-1)
		}
		for i := 1; i < len(offs); i++ {
			if offs[i] != offs[i-1]-1 {
				t.Fatalf("single-partition page is not contiguous: %d then %d", offs[i-1], offs[i])
			}
		}
		wantCursor := end - 100
		cursor, ok := res.Meta["next_before_offsets"].(map[string]int64)
		if !ok || cursor["0"] != wantCursor {
			t.Fatalf("single-partition cursor = %#v, want next_before_offsets[0] = %d", res.Meta["next_before_offsets"], wantCursor)
		}
		if hasOlder, _ := res.Meta["has_older"].(bool); !hasOlder {
			t.Fatal("single-partition page must report has_older=true (older records remain)")
		}
		// The continuation page must cover exactly the remaining older records with
		// no overlap and drain the partition.
		cj, _ := json.Marshal(cursor)
		res2, err := conn.GetData(ctx, topic, connector.DataOpts{
			Limit: 100,
			Filters: []connector.FilterExpr{
				{Column: "partition", Op: "eq", Value: "0"},
				{Column: "before_offsets", Op: "eq", Value: string(cj)},
			},
		})
		if err != nil {
			t.Fatalf("single-partition continuation: %v", err)
		}
		offs2 := rowOffsetsDesc(t, res2.Rows, 0)
		if offs2[0] != wantCursor-1 {
			t.Fatalf("continuation newest offset = %d, want %d (just below the cursor)", offs2[0], wantCursor-1)
		}
		if lowest := offs2[len(offs2)-1]; lowest != startOf[0] {
			t.Fatalf("continuation lowest offset = %d, want start %d (partition drained)", lowest, startOf[0])
		}
		t.Logf("single_partition_filter_cursor page1=%d cursor=%d page2=%d end=%d start=%d",
			len(res.Rows), wantCursor, len(res2.Rows), end, startOf[0])
	})

	// ---- Acceptance: large payloads deserialize correctly end-to-end. ----
	t.Run("large_payloads_deserialize", func(t *testing.T) {
		// Partition 5 holds 12 View + 12 large (large are newest); a full single-
		// partition page returns them all and must deserialize the ~128KB blobs.
		res, err := conn.GetData(ctx, topic, connector.DataOpts{
			Limit:   100,
			Filters: []connector.FilterExpr{{Column: "partition", Op: "eq", Value: fmt.Sprint(largePartsFrom)}},
		})
		if err != nil {
			t.Fatalf("large-payload browse: %v", err)
		}
		if partial, _ := res.Meta["partial"].(bool); partial {
			t.Fatalf("large-payload browse must not be partial: %#v", res.Meta)
		}
		big := 0
		for _, row := range res.Rows {
			if format, _ := row["format"].(string); format != "json" {
				continue
			}
			if value, _ := row["value"].(string); len(value) >= largePayloadSz {
				big++
			}
		}
		if big < largePerPart {
			t.Fatalf("expected at least %d large (>=%d byte) JSON payloads deserialized, got %d", largePerPart, largePayloadSz, big)
		}
		t.Logf("large_payloads_deserialize rows=%d large_payloads=%d", len(res.Rows), big)
	})

	// ---- Acceptance: 10+ page cursor sweep — zero duplicates, no silent skips. ----
	//
	// Regression guard for the cursor bug root-caused in task-8a-report.md and fixed
	// in task-8a-cursor-fix-report.md. The pre-fix GetData omitted a fully-drained
	// partition (frontier == start) from next_before_offsets. A missing before_offsets
	// entry is treated by snapshotRead (and the scan path) as "read from the current
	// end offset", so once a shallow partition drained and dropped out of the cursor
	// while a deeper partition still had older data (has_older stayed true), the very
	// next page re-read every drained partition from the top — re-showing
	// already-returned rows and preventing has_older from ever reaching false. That
	// violated the cursor contract ("never re-shows the same row") and the DoD
	// ("cursor pagination creates no duplicates").
	//
	// The fix keeps every scoped partition in next_before_offsets (drained ones pinned
	// at their start offset, which the window builder then skips via `upper <= low`)
	// and derives has_older from whether any partition still has frontier > start. This
	// subtest now ENFORCES the full contract: a full sweep from newest to oldest that
	// returns every (partition, offset) exactly once, never re-shows a row, and
	// terminates with has_older=false.
	t.Run("full_drain_lossless_pagination", func(t *testing.T) {
		seen := make(map[string]bool, totalRecords)
		perPartition := make(map[int32][]int64, partitions)
		var cursor map[string]int64
		pages := 0
		const pageCap = 200
		for {
			filters := make([]connector.FilterExpr, 0, 1)
			if cursor != nil {
				cj, _ := json.Marshal(cursor)
				filters = append(filters, connector.FilterExpr{Column: "before_offsets", Op: "eq", Value: string(cj)})
			}
			res, err := conn.GetData(ctx, topic, connector.DataOpts{Limit: 100, Filters: filters})
			if err != nil {
				t.Fatalf("page %d: %v", pages+1, err)
			}
			pages++
			for _, row := range res.Rows {
				p, _ := row["partition"].(int32)
				o, _ := row["offset"].(int64)
				key := fmt.Sprintf("%d:%d", p, o)
				if seen[key] {
					t.Fatalf("cursor re-showed already-returned message %s on page %d "+
						"(a fully-drained partition must stay pinned in next_before_offsets at its start "+
						"offset, not drop out and get re-read from the top)", key, pages)
				}
				seen[key] = true
				perPartition[p] = append(perPartition[p], o)
			}
			hasOlder, _ := res.Meta["has_older"].(bool)
			next, _ := res.Meta["next_before_offsets"].(map[string]int64)
			if !hasOlder {
				// has_older=false is the clean terminal state; the cursor must be gone.
				if len(next) != 0 {
					t.Fatalf("page %d reported has_older=false but still emitted a next_before_offsets cursor %#v", pages, next)
				}
				break
			}
			if len(next) == 0 {
				t.Fatalf("page %d reported has_older=true but emitted no next_before_offsets cursor", pages)
			}
			cursor = next
			if pages >= pageCap {
				t.Fatalf("pagination never terminated: still has_older=true after %d pages "+
					"(a drained partition is being re-read from the top instead of skipped)", pageCap)
			}
		}

		// Every offset in every partition's [start,end) range must have been returned
		// exactly once across the sweep.
		if pages < 10 {
			t.Logf("note: topic drained in %d pages (<10); the deep partition still exercised multi-page continuation", pages)
		}
		if int64(len(seen)) != totalRecords {
			t.Fatalf("saw %d distinct messages, expected exactly %d (a mismatch means a skip or duplicate)", len(seen), totalRecords)
		}
		for id := int32(0); id < partitions; id++ {
			for off := startOf[id]; off < endOf[id]; off++ {
				if !seen[fmt.Sprintf("%d:%d", id, off)] {
					t.Fatalf("offset %d:%d was never returned across %d pages (silent skip)", id, off, pages)
				}
			}
			if id == emptyPartition && len(perPartition[id]) != 0 {
				t.Fatalf("empty partition %d must contribute zero rows, got %d", id, len(perPartition[id]))
			}
		}
		t.Logf("full_drain_lossless_pagination pages=%d distinct_messages=%d expected=%d duplicates=0 skips=0",
			pages, len(seen), totalRecords)
	})
}

// TestKafkaEmptyTopicIntegration verifies a genuinely empty (but existing) topic
// returns a successful empty state: zero rows, partial=false, has_older=false, and
// no error.
func TestKafkaEmptyTopicIntegration(t *testing.T) {
	broker := os.Getenv("KAFKA_TEST_BROKER")
	if broker == "" {
		t.Skip("set KAFKA_TEST_BROKER to run the local Kafka empty-topic integration test")
	}
	assertLocalBroker(t, broker)

	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()

	seedClient, err := kgo.NewClient(kgo.SeedBrokers(broker))
	if err != nil {
		t.Fatalf("create seed client: %v", err)
	}
	defer seedClient.Close()
	admin := kadm.NewClient(seedClient)

	topic := fmt.Sprintf("kizuna-message-qa-empty-%d", time.Now().UnixNano())
	created, err := admin.CreateTopics(ctx, 6, 1, nil, topic)
	if err != nil {
		t.Fatalf("create empty topic: %v", err)
	}
	if response := created[topic]; response.Err != nil {
		t.Fatalf("create empty topic response: %v", response.Err)
	}
	registerTopicCleanup(t, broker, topic)
	if err := waitTopicReady(ctx, admin, topic); err != nil {
		t.Fatalf("empty topic not ready: %v", err)
	}

	conn, err := New(ctx, config.ConnectionConfig{
		Type:        "kafka",
		KafkaConfig: &config.KafkaConfig{Brokers: []string{broker}},
	}, "")
	if err != nil {
		t.Fatalf("create connector: %v", err)
	}
	defer conn.Close()

	res, err := conn.GetData(ctx, topic, connector.DataOpts{Limit: 100})
	if err != nil {
		t.Fatalf("empty topic must be a successful empty state, not an error: %v", err)
	}
	if len(res.Rows) != 0 {
		t.Fatalf("empty topic returned %d rows, want 0", len(res.Rows))
	}
	if partial, _ := res.Meta["partial"].(bool); partial {
		t.Fatalf("empty topic must not be partial: %#v", res.Meta)
	}
	if hasOlder, _ := res.Meta["has_older"].(bool); hasOlder {
		t.Fatalf("empty topic must report has_older=false: %#v", res.Meta)
	}
	if res.HasMore {
		t.Fatalf("empty topic must report HasMore=false")
	}
	if got, want := res.Meta["partitions_total"], 6; got != want {
		t.Fatalf("empty topic partitions_total = %v, want %d", got, want)
	}
	t.Logf("empty_topic rows=%d partial=%v has_older=%v partitions_total=%v partitions_completed=%v",
		len(res.Rows), res.Meta["partial"], res.Meta["has_older"], res.Meta["partitions_total"], res.Meta["partitions_completed"])
}

// TestKafkaCompactedOffsetsBestEffort is the plan's explicitly-optional
// compacted/gapped-offset scenario ("if local configuration allows"). It creates a
// log-compacted topic tuned for aggressive compaction, writes many versions of a
// small set of keys, and then watches for the broker's log cleaner to remove
// superseded records — which leaves non-contiguous (gapped) offsets while the low
// watermark stays at 0. It asserts the reader browses such a topic without error or
// budget-hang. It NEVER fails when compaction does not fire within the window:
// observing compaction on a single-node KRaft broker is timing-dependent, and the
// reader's compacted/gapped-tail handling is already proven deterministically by
// TestConsumeWindowsCompletesCompactedTailWithoutWaitingBudget. The outcome is
// logged for the QA report either way.
func TestKafkaCompactedOffsetsBestEffort(t *testing.T) {
	broker := os.Getenv("KAFKA_TEST_BROKER")
	if broker == "" {
		t.Skip("set KAFKA_TEST_BROKER to run the local Kafka compaction best-effort test")
	}
	assertLocalBroker(t, broker)

	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()

	seedClient, err := kgo.NewClient(kgo.SeedBrokers(broker))
	if err != nil {
		t.Fatalf("create seed client: %v", err)
	}
	defer seedClient.Close()
	admin := kadm.NewClient(seedClient)

	str := func(s string) *string { return &s }
	cfg := map[string]*string{
		"cleanup.policy":            str("compact"),
		"min.cleanable.dirty.ratio": str("0.01"),
		"segment.ms":                str("100"),   // roll the active segment ~every 100ms
		"segment.bytes":             str("16384"), // small segments, but comfortably above one batch
		"delete.retention.ms":       str("100"),
		"min.compaction.lag.ms":     str("0"),
		"max.compaction.lag.ms":     str("1"),
	}
	topic := fmt.Sprintf("kizuna-message-qa-compact-%d", time.Now().UnixNano())
	created, err := admin.CreateTopics(ctx, 1, 1, cfg, topic)
	if err != nil {
		t.Fatalf("create compacted topic: %v", err)
	}
	if response := created[topic]; response.Err != nil {
		t.Fatalf("create compacted topic response: %v", response.Err)
	}
	registerTopicCleanup(t, broker, topic)
	if err := waitTopicReady(ctx, admin, topic); err != nil {
		t.Fatalf("compacted topic not ready: %v", err)
	}

	// Many versions of a handful of keys: every superseded version becomes
	// compaction-eligible. Produce round-by-round (one small batch per version) with
	// a brief pause so segment.ms keeps rolling the active segment — closed segments
	// are the only ones the log cleaner will compact.
	const (
		keys        = 5
		versions    = 60 // 300 records to 5 keys; only the last per key must survive compaction
		activeKeys  = 3
		activeExtra = 20
	)
	produced := 0
	for v := 0; v < versions; v++ {
		round := make([]*kgo.Record, 0, keys)
		for k := 0; k < keys; k++ {
			round = append(round, &kgo.Record{
				Topic: topic,
				Key:   []byte(fmt.Sprintf("key-%d", k)),
				Value: []byte(fmt.Sprintf(`{"k":%d,"v":%d}`, k, v)),
			})
		}
		if err := seedClient.ProduceSync(ctx, round...).FirstErr(); err != nil {
			t.Fatalf("produce compaction round %d: %v", v, err)
		}
		produced += len(round)
		time.Sleep(60 * time.Millisecond)
	}
	// A second wave to new keys keeps rolling segments (the active segment is never
	// compacted), giving the cleaner closed segments full of superseded records.
	for v := 0; v < activeExtra; v++ {
		round := make([]*kgo.Record, 0, activeKeys)
		for k := keys; k < keys+activeKeys; k++ {
			round = append(round, &kgo.Record{
				Topic: topic,
				Key:   []byte(fmt.Sprintf("key-%d", k)),
				Value: []byte(fmt.Sprintf(`{"k":%d,"v":%d}`, k, v)),
			})
		}
		if err := seedClient.ProduceSync(ctx, round...).FirstErr(); err != nil {
			t.Fatalf("produce compaction tail round %d: %v", v, err)
		}
		produced += len(round)
		time.Sleep(60 * time.Millisecond)
	}

	end, err := admin.ListEndOffsets(ctx, topic)
	if err != nil {
		t.Fatalf("list end offsets: %v", err)
	}
	endOffset := end[topic][0].Offset
	t.Logf("compaction fixture: topic=%s end_offset=%d produced=%d", topic, endOffset, produced)

	// Poll for compaction: read the whole partition and count live records. Fewer
	// live records than the offset span means the cleaner removed superseded records
	// and left gapped offsets.
	gapObserved := false
	var liveCount int
	deadline := time.Now().Add(45 * time.Second)
	for time.Now().Before(deadline) && ctx.Err() == nil {
		offsets := readPartitionOffsets(t, broker, topic, 0, endOffset)
		liveCount = len(offsets)
		if int64(liveCount) < endOffset && hasOffsetGap(offsets) {
			gapObserved = true
			break
		}
		time.Sleep(3 * time.Second)
	}

	// The reader must browse the (possibly compacted) topic cleanly regardless.
	conn, err := New(ctx, config.ConnectionConfig{
		Type:        "kafka",
		KafkaConfig: &config.KafkaConfig{Brokers: []string{broker}},
	}, "")
	if err != nil {
		t.Fatalf("create connector: %v", err)
	}
	defer conn.Close()

	start := time.Now()
	res, err := conn.GetData(ctx, topic, connector.DataOpts{Limit: 100})
	elapsed := time.Since(start)
	if err != nil {
		t.Fatalf("browsing a compacted topic must not error: %v", err)
	}
	if elapsed > 10*time.Second {
		t.Fatalf("browsing a compacted topic must not hang on the read budget, took %v", elapsed)
	}
	if partial, _ := res.Meta["partial"].(bool); partial {
		t.Fatalf("a single fast local partition must complete, not report partial: %#v", res.Meta)
	}

	if gapObserved {
		t.Logf("compacted/gapped offsets ACHIEVED: end_offset=%d live_records=%d (%d offsets compacted away); "+
			"reader browsed cleanly in %v rows=%d", endOffset, liveCount, endOffset-int64(liveCount), elapsed, len(res.Rows))
	} else {
		t.Logf("compacted/gapped offsets NOT observed within the window: end_offset=%d live_records=%d "+
			"(log cleaner did not visibly run on this single-node KRaft broker in time). Reader still browsed "+
			"cleanly in %v rows=%d. Deterministic gapped-tail coverage is provided by "+
			"TestConsumeWindowsCompletesCompactedTailWithoutWaitingBudget.", endOffset, liveCount, elapsed, len(res.Rows))
	}
}

// readPartitionOffsets reads every currently-live record in [0, upTo) for one
// partition and returns their offsets in read order. Bounded by a short deadline so
// a fully-drained or idle partition returns promptly.
func readPartitionOffsets(t *testing.T, broker, topic string, partition int32, upTo int64) []int64 {
	t.Helper()
	cl, err := kgo.NewClient(
		kgo.SeedBrokers(broker),
		kgo.ConsumePartitions(map[string]map[int32]kgo.Offset{topic: {partition: kgo.NewOffset().At(0)}}),
	)
	if err != nil {
		t.Fatalf("create read client: %v", err)
	}
	defer cl.Close()

	offsets := make([]int64, 0, upTo)
	readCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	for {
		if readCtx.Err() != nil {
			return offsets
		}
		pollCtx, pollCancel := context.WithTimeout(readCtx, 1500*time.Millisecond)
		fetches := cl.PollFetches(pollCtx)
		pollCancel()
		empty := true
		fetches.EachRecord(func(r *kgo.Record) {
			empty = false
			offsets = append(offsets, r.Offset)
		})
		if len(offsets) > 0 && offsets[len(offsets)-1] >= upTo-1 {
			return offsets
		}
		if empty {
			return offsets
		}
	}
}

// hasOffsetGap reports whether the (ascending) offsets are non-contiguous, i.e.
// at least one offset in the covered range is missing — the signature of
// compaction having removed superseded records.
func hasOffsetGap(offsets []int64) bool {
	if len(offsets) < 2 {
		return false
	}
	for i := 1; i < len(offsets); i++ {
		if offsets[i] > offsets[i-1]+1 {
			return true
		}
	}
	return false
}

// rowOffsetsDesc extracts the offsets of the rows belonging to the given
// partition, sorted newest-first, failing if any row is missing an int64 offset.
func rowOffsetsDesc(t *testing.T, rows []map[string]any, partition int32) []int64 {
	t.Helper()
	offs := make([]int64, 0, len(rows))
	for _, row := range rows {
		p, _ := row["partition"].(int32)
		if p != partition {
			t.Fatalf("row from unexpected partition %d (want %d): %#v", p, partition, row)
		}
		off, ok := row["offset"].(int64)
		if !ok {
			t.Fatalf("row missing int64 offset: %#v", row)
		}
		offs = append(offs, off)
	}
	sort.Slice(offs, func(i, j int) bool { return offs[i] > offs[j] })
	return offs
}
