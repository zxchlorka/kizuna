package kafka

import (
	"context"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/twmb/franz-go/pkg/kerr"
	"github.com/twmb/franz-go/pkg/kgo"
	"github.com/zxchlorka/kizuna/internal/connector"
)

// These tests exercise the fast-snapshot reader contract (Task 1, TDD red).
// The real bounded-quota reader lands in Task 2, so a few scenarios fail on
// purpose against today's reader; each failing assertion is called out in the
// task report. The rest guard invariants the new reader must preserve.
//
// consumeWindows talks to a small partitionConsumer seam (see messages.go)
// instead of *kgo.Client directly, which lets fakeConsumer script broker
// replies deterministically — no live cluster, no flaky timing.

// fakeConsumer is a deterministic stand-in for the subset of *kgo.Client that
// consumeWindows drives. Each PollFetches call pops the next scripted round;
// once the script is exhausted it blocks until the caller's context is done and
// then returns an empty fetch, mimicking franz-go returning after FetchMaxWait
// or when the poll context is canceled.
type fakeConsumer struct {
	mu     sync.Mutex
	rounds []kgo.Fetches
	idx    int
	polls  int

	// clientClosed makes every poll report a closed client.
	clientClosed bool

	added   []map[string]map[int32]kgo.Offset
	removed []map[string][]int32
	paused  [][]int32
	resumed []map[string][]int32
}

func (f *fakeConsumer) AddConsumePartitions(p map[string]map[int32]kgo.Offset) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.added = append(f.added, p)
}

func (f *fakeConsumer) RemoveConsumePartitions(p map[string][]int32) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.removed = append(f.removed, p)
}

func (f *fakeConsumer) PauseFetchPartitions(p map[string][]int32) map[string][]int32 {
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, ids := range p {
		f.paused = append(f.paused, ids)
	}
	return p
}

func (f *fakeConsumer) ResumeFetchPartitions(p map[string][]int32) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.resumed = append(f.resumed, p)
}

func (f *fakeConsumer) PollFetches(ctx context.Context) kgo.Fetches {
	f.mu.Lock()
	f.polls++
	if f.clientClosed {
		f.mu.Unlock()
		return clientClosedFetches()
	}
	if f.idx < len(f.rounds) {
		round := f.rounds[f.idx]
		f.idx++
		f.mu.Unlock()
		return round
	}
	f.mu.Unlock()
	// Script exhausted: emulate a broker with no further data by returning only
	// once the caller's budget or cancellation fires, exactly as franz-go does
	// after FetchMaxWait or when the poll context is canceled.
	<-ctx.Done()
	return kgo.Fetches{}
}

// partitionFetch describes one partition's slice of a scripted poll round.
type partitionFetch struct {
	partition     int32
	highWatermark int64
	err           error
	records       []*kgo.Record
}

// fetchRound assembles a kgo.Fetches for a single topic. kgo.Fetches is a plain
// slice of exported structs, so it can be built by hand for tests.
func fetchRound(topic string, parts ...partitionFetch) kgo.Fetches {
	fps := make([]kgo.FetchPartition, 0, len(parts))
	for _, p := range parts {
		fps = append(fps, kgo.FetchPartition{
			Partition:     p.partition,
			Err:           p.err,
			HighWatermark: p.highWatermark,
			Records:       p.records,
		})
	}
	return kgo.Fetches{
		{Topics: []kgo.FetchTopic{{Topic: topic, Partitions: fps}}},
	}
}

func fetchRecord(topic string, partition int32, offset int64, value string) *kgo.Record {
	return &kgo.Record{
		Topic:     topic,
		Partition: partition,
		Offset:    offset,
		// Distinct, offset-ordered timestamps keep row ordering deterministic.
		Timestamp: time.Unix(0, offset*int64(time.Millisecond)).UTC(),
		Value:     []byte(value),
	}
}

// clientClosedFetches mirrors the single-partition ErrClientClosed shape that
// franz-go injects so Fetches.IsClientClosed() reports true.
func clientClosedFetches() kgo.Fetches {
	return kgo.Fetches{
		{Topics: []kgo.FetchTopic{
			{Topic: "", Partitions: []kgo.FetchPartition{{Partition: 0, Err: kgo.ErrClientClosed}}},
		}},
	}
}

func rowOffset(t *testing.T, row map[string]any) int64 {
	t.Helper()
	off, ok := row["offset"].(int64)
	if !ok {
		t.Fatalf("row is missing an int64 offset: %#v", row)
	}
	return off
}

// Deferred deserialization: the consume stage must produce raw candidates that
// carry copied payload bytes but are NOT deserialized. Only the rows that
// survive final page selection get deserialized, so the many large-payload
// candidates that are discarded pre-merge never allocate parsed JSON. This is
// the memory guard from Task 2's "ограничить память candidate budget" item.
func TestConsumeWindowsDefersDeserializationUntilFinalPage(t *testing.T) {
	t.Parallel()

	const (
		topic        = "big-payloads"
		partitions   = 6
		perPartition = 30
		pageSize     = 100
	)
	// A large, valid JSON payload. Deserializing all partitions*perPartition of
	// these pre-merge would be the memory blow-up the deferred pipeline avoids.
	largePayload := `{"blob":"` + strings.Repeat("A", 128*1024) + `"}`

	parts := make([]partitionFetch, 0, partitions)
	for p := int32(0); p < partitions; p++ {
		records := make([]*kgo.Record, 0, perPartition)
		for off := int64(0); off < perPartition; off++ {
			records = append(records, fetchRecord(topic, p, off, largePayload))
		}
		parts = append(parts, partitionFetch{partition: p, highWatermark: perPartition, records: records})
	}
	fake := &fakeConsumer{rounds: []kgo.Fetches{fetchRound(topic, parts...)}}
	conn := &KafkaConnector{consume: fake}

	windows := make(map[int32]partitionWindow, partitions)
	for p := int32(0); p < partitions; p++ {
		windows[p] = partitionWindow{from: 0, upper: perPartition}
	}

	res, err := conn.consumeWindows(context.Background(), topic, windows, pageSize, 2*time.Second)
	if err != nil {
		t.Fatalf("consumeWindows: %v", err)
	}
	if want := partitions * perPartition; len(res.rows) != want {
		t.Fatalf("expected %d raw candidates, got %d", want, len(res.rows))
	}
	// Every raw candidate must retain copied bytes and must NOT be deserialized.
	for _, row := range res.rows {
		if _, deserialized := row["value"]; deserialized {
			t.Fatal("consume stage must defer value deserialization")
		}
		if _, deserialized := row["format"]; deserialized {
			t.Fatal("consume stage must defer format detection")
		}
		if _, ok := row[rawValueField].([]byte); !ok {
			t.Fatal("consume stage must retain copied raw value bytes")
		}
	}

	// Only the selected page is deserialized for display.
	page := finalizeRows(selectNewestPrefixes(res.rows, pageSize))
	if len(page) != pageSize {
		t.Fatalf("expected a %d-row page, got %d", pageSize, len(page))
	}
	for _, row := range page {
		value, ok := row["value"].(string)
		if !ok || value == "" {
			t.Fatalf("final page rows must be deserialized: %#v", row["format"])
		}
		if format, _ := row["format"].(string); format != "json" {
			t.Fatalf("expected json format for the large payload, got %q", format)
		}
		if _, leaked := row[rawValueField]; leaked {
			t.Fatal("display rows must not leak internal raw fields")
		}
	}
}

// initialPartitionQuota: 54 partitions on a 100-message page must read a small
// per-partition window (2), not the whole page from every partition. RED until
// Task 2 replaces normalPartitionWindow with the bounded quota.
func TestInitialPartitionQuotaFavorsCoverageOverDepth(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name       string
		pageSize   int
		partitions int
		want       int64
	}{
		{name: "54 partitions page 100 reads two per partition", pageSize: 100, partitions: 54, want: 2},
		{name: "even split is two per partition", pageSize: 100, partitions: 50, want: 2},
		{name: "ceil rounds the window up", pageSize: 100, partitions: 40, want: 3},
		{name: "never drops below one", pageSize: 10, partitions: 40, want: 1},
		{name: "single scoped partition reads the whole page", pageSize: 100, partitions: 1, want: 100},
	}

	for _, tc := range tests {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			if got := initialPartitionQuota(tc.pageSize, tc.partitions); got != tc.want {
				t.Fatalf("initialPartitionQuota(%d, %d) = %d, want %d", tc.pageSize, tc.partitions, got, tc.want)
			}
		})
	}
}

// All scoped partitions finish within budget: partial=false, every row returned.
func TestConsumeWindowsCompletesEveryPartition(t *testing.T) {
	t.Parallel()

	const topic = "orders"
	fake := &fakeConsumer{rounds: []kgo.Fetches{
		fetchRound(topic,
			partitionFetch{partition: 0, highWatermark: 3, records: []*kgo.Record{
				fetchRecord(topic, 0, 1, `{"n":1}`),
				fetchRecord(topic, 0, 2, `{"n":2}`),
			}},
			partitionFetch{partition: 1, highWatermark: 5, records: []*kgo.Record{
				fetchRecord(topic, 1, 3, `{"n":3}`),
				fetchRecord(topic, 1, 4, `{"n":4}`),
			}},
		),
	}}
	conn := &KafkaConnector{consume: fake}

	windows := map[int32]partitionWindow{
		0: {from: 1, upper: 3},
		1: {from: 3, upper: 5},
	}
	res, err := conn.consumeWindows(context.Background(), topic, windows, 100, 2*time.Second)
	if err != nil {
		t.Fatalf("consumeWindows: %v", err)
	}
	if res.partial {
		t.Fatalf("expected partial=false when every partition completes")
	}
	if res.timedOut {
		t.Fatalf("expected timedOut=false when every partition completes")
	}
	if len(res.completed) != 2 || !res.completed[0] || !res.completed[1] {
		t.Fatalf("expected both partitions completed, got %#v", res.completed)
	}
	if len(res.rows) != 4 {
		t.Fatalf("expected 4 rows across both partitions, got %d", len(res.rows))
	}
}

// One partition never reaches its window end before the budget expires. The
// finished partitions' rows must still come back, flagged partial=true rather
// than discarded or turned into an error. RED: today's reader never sets
// partial (it flags timedOut and the caller currently turns that into
// ErrTimeout at the GetData layer).
func TestConsumeWindowsReturnsPartialWhenPartitionMissesBudget(t *testing.T) {
	t.Parallel()

	const topic = "orders"
	fake := &fakeConsumer{rounds: []kgo.Fetches{
		fetchRound(topic,
			partitionFetch{partition: 0, highWatermark: 3, records: []*kgo.Record{
				fetchRecord(topic, 0, 1, `{"n":1}`),
				fetchRecord(topic, 0, 2, `{"n":2}`),
			}},
			// Partition 1 delivers one record but never reaches upper-1, so it
			// stays unfinished until the budget expires.
			partitionFetch{partition: 1, highWatermark: 50, records: []*kgo.Record{
				fetchRecord(topic, 1, 40, `{"n":40}`),
			}},
		),
	}}
	conn := &KafkaConnector{consume: fake}

	windows := map[int32]partitionWindow{
		0: {from: 1, upper: 3},
		1: {from: 40, upper: 50}, // needs offset 49, never delivered
	}
	start := time.Now()
	res, err := conn.consumeWindows(context.Background(), topic, windows, 100, 150*time.Millisecond)
	elapsed := time.Since(start)
	if err != nil {
		t.Fatalf("consumeWindows returned an error instead of a partial success: %v", err)
	}
	if !res.partial {
		t.Fatalf("expected partial=true when a partition misses the read budget")
	}
	if !res.completed[0] {
		t.Fatalf("expected partition 0 to complete")
	}
	if res.completed[1] {
		t.Fatalf("expected partition 1 to remain incomplete")
	}
	if len(res.rows) != 2 {
		t.Fatalf("completed partition rows must survive a partial read, got %d rows", len(res.rows))
	}
	if elapsed > time.Second {
		t.Fatalf("consumeWindows should return near the budget, took %v", elapsed)
	}
}

// A genuine broker/auth error must surface as an error, never as a partial
// success. Guards the invariant across Task 2.
func TestConsumeWindowsPropagatesBrokerErrors(t *testing.T) {
	t.Parallel()

	const topic = "orders"
	windows := map[int32]partitionWindow{0: {from: 0, upper: 10}}

	tests := []struct {
		name    string
		fake    *fakeConsumer
		wantErr error
	}{
		{
			name: "auth failure",
			fake: &fakeConsumer{rounds: []kgo.Fetches{
				fetchRound(topic, partitionFetch{partition: 0, err: kerr.TopicAuthorizationFailed}),
			}},
			wantErr: connector.ErrForbidden,
		},
		{
			name:    "client closed",
			fake:    &fakeConsumer{clientClosed: true},
			wantErr: connector.ErrUnavailable,
		},
	}

	for _, tc := range tests {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			conn := &KafkaConnector{consume: tc.fake}
			res, err := conn.consumeWindows(context.Background(), topic, windows, 100, time.Second)
			if err == nil {
				t.Fatalf("expected an error, got result %#v", res)
			}
			if !errors.Is(err, tc.wantErr) {
				t.Fatalf("expected %v, got %v", tc.wantErr, err)
			}
			if res != nil {
				t.Fatalf("a hard broker error must not return a (partial) result, got %#v", res)
			}
		})
	}
}

// Budget exhausted with zero rows AND zero completed partitions is not an empty
// success — it must be a timeout/unavailable error. RED: today's reader returns
// a nil error with an empty result here.
func TestConsumeWindowsErrorsWhenNothingIsReadable(t *testing.T) {
	t.Parallel()

	const topic = "orders"
	// The broker never returns records and never reaches any window end, so the
	// whole budget is spent without a single completed partition.
	fake := &fakeConsumer{}
	conn := &KafkaConnector{consume: fake}

	windows := map[int32]partitionWindow{
		0: {from: 0, upper: 10},
		1: {from: 0, upper: 10},
	}
	res, err := conn.consumeWindows(context.Background(), topic, windows, 100, 120*time.Millisecond)
	if err == nil {
		t.Fatalf("expected a timeout/unavailable error, got result %#v", res)
	}
	if !errors.Is(err, connector.ErrTimeout) && !errors.Is(err, connector.ErrUnavailable) {
		t.Fatalf("expected timeout/unavailable, got %v", err)
	}
}

// An empty topic whose partitions all cleanly drain is a successful empty
// result: no rows, no partial flag, every partition completed. Guards the
// complement of the "nothing readable" error case.
func TestConsumeWindowsEmptyButCompletedIsSuccess(t *testing.T) {
	t.Parallel()

	const topic = "orders"
	// Each partition immediately reports an empty range whose high watermark is
	// already at/above the window end: a cleanly drained/empty partition.
	fake := &fakeConsumer{rounds: []kgo.Fetches{
		fetchRound(topic,
			partitionFetch{partition: 0, highWatermark: 10},
			partitionFetch{partition: 1, highWatermark: 10},
		),
	}}
	conn := &KafkaConnector{consume: fake}

	windows := map[int32]partitionWindow{
		0: {from: 5, upper: 10},
		1: {from: 5, upper: 10},
	}
	res, err := conn.consumeWindows(context.Background(), topic, windows, 100, 2*time.Second)
	if err != nil {
		t.Fatalf("cleanly completed empty partitions should succeed: %v", err)
	}
	if res.partial {
		t.Fatalf("cleanly completed empty partitions are not partial")
	}
	if len(res.rows) != 0 {
		t.Fatalf("expected zero rows, got %d", len(res.rows))
	}
	if len(res.completed) != 2 {
		t.Fatalf("expected both partitions completed, got %#v", res.completed)
	}
}

// A compacted/gapped tail (records stop before the reported end offset)
// completes via a short empty fetch whose high watermark already covers the
// window, instead of waiting out the whole read budget.
func TestConsumeWindowsCompletesCompactedTailWithoutWaitingBudget(t *testing.T) {
	t.Parallel()

	const topic = "orders"
	// Records exist only up to offset 42, but the window's exclusive upper is 60
	// (the reported end offset). Offset 59 will never arrive; completion must
	// come from the empty fetch, not from spending the budget.
	fake := &fakeConsumer{rounds: []kgo.Fetches{
		fetchRound(topic, partitionFetch{partition: 0, highWatermark: 60, records: []*kgo.Record{
			fetchRecord(topic, 0, 41, `{"n":41}`),
			fetchRecord(topic, 0, 42, `{"n":42}`),
		}}),
		fetchRound(topic, partitionFetch{partition: 0, highWatermark: 60}),
	}}
	conn := &KafkaConnector{consume: fake}

	windows := map[int32]partitionWindow{0: {from: 40, upper: 60}}
	start := time.Now()
	res, err := conn.consumeWindows(context.Background(), topic, windows, 100, 5*time.Second)
	elapsed := time.Since(start)
	if err != nil {
		t.Fatalf("consumeWindows: %v", err)
	}
	if !res.completed[0] {
		t.Fatalf("compacted tail should complete via the empty fetch")
	}
	if res.timedOut || res.partial {
		t.Fatalf("compacted tail completion must not look like a timeout/partial")
	}
	if len(res.rows) != 2 {
		t.Fatalf("expected the 2 real records, got %d", len(res.rows))
	}
	if elapsed > 2*time.Second {
		t.Fatalf("completion must not wait out the 5s budget, took %v", elapsed)
	}
}

// Caller cancellation stops consume promptly even with a generous read budget.
func TestConsumeWindowsStopsOnContextCancellation(t *testing.T) {
	t.Parallel()

	const topic = "orders"
	// Deliver one non-completing record, then block. A 10s budget means only
	// honoring the caller's cancellation can return promptly.
	fake := &fakeConsumer{rounds: []kgo.Fetches{
		fetchRound(topic, partitionFetch{partition: 0, highWatermark: 100, records: []*kgo.Record{
			fetchRecord(topic, 0, 10, `{"n":10}`),
		}}),
	}}
	conn := &KafkaConnector{consume: fake}

	windows := map[int32]partitionWindow{0: {from: 0, upper: 100}} // needs offset 99
	ctx, cancel := context.WithCancel(context.Background())
	go func() {
		time.Sleep(30 * time.Millisecond)
		cancel()
	}()

	start := time.Now()
	if _, err := conn.consumeWindows(ctx, topic, windows, 100, 10*time.Second); err != nil {
		// A cancellation may surface as a result or an error depending on Task 2;
		// this test only pins down promptness, so either outcome is acceptable.
		_ = err
	}
	if elapsed := time.Since(start); elapsed > 2*time.Second {
		t.Fatalf("caller cancellation must stop consume promptly, took %v", elapsed)
	}
}

// A single scoped partition reads its newest prefix and yields the same
// per-partition cursor contract (lowest returned offset) as the multi-partition
// path.
func TestConsumeWindowsSinglePartitionCursorContract(t *testing.T) {
	t.Parallel()

	const topic = "orders"
	fake := &fakeConsumer{rounds: []kgo.Fetches{
		fetchRound(topic, partitionFetch{partition: 3, highWatermark: 100, records: []*kgo.Record{
			fetchRecord(topic, 3, 97, `{"n":97}`),
			fetchRecord(topic, 3, 98, `{"n":98}`),
			fetchRecord(topic, 3, 99, `{"n":99}`),
		}}),
	}}
	conn := &KafkaConnector{consume: fake}

	windows := map[int32]partitionWindow{3: {from: 97, upper: 100}}
	res, err := conn.consumeWindows(context.Background(), topic, windows, 100, 2*time.Second)
	if err != nil {
		t.Fatalf("consumeWindows: %v", err)
	}
	if len(res.completed) != 1 || !res.completed[3] {
		t.Fatalf("expected exactly partition 3 completed, got %#v", res.completed)
	}
	if len(res.rows) != 3 {
		t.Fatalf("expected 3 rows, got %d", len(res.rows))
	}
	cursor := lowestConsumedOffsets(res.rows)
	if cursor[3] != 97 {
		t.Fatalf("single-partition cursor must be the lowest returned offset, got %#v", cursor)
	}
}

// Two consecutive pages, where page 2's exclusive upper is page 1's lowest
// returned offset, must neither repeat an offset nor skip one. This pins down
// the lossless cursor invariant across pages.
func TestConsumeWindowsPaginationIsLosslessAcrossPages(t *testing.T) {
	t.Parallel()

	const topic = "orders"
	recordsFor := func(from, upper int64) []*kgo.Record {
		recs := make([]*kgo.Record, 0, upper-from)
		for off := from; off < upper; off++ {
			recs = append(recs, fetchRecord(topic, 0, off, `{"n":1}`))
		}
		return recs
	}

	// Page 1 reads the newest window [190,200).
	page1Fake := &fakeConsumer{rounds: []kgo.Fetches{
		fetchRound(topic, partitionFetch{partition: 0, highWatermark: 200, records: recordsFor(190, 200)}),
	}}
	page1, err := (&KafkaConnector{consume: page1Fake}).consumeWindows(
		context.Background(), topic, map[int32]partitionWindow{0: {from: 190, upper: 200}}, 100, time.Second)
	if err != nil {
		t.Fatalf("page 1: %v", err)
	}

	nextUpper := lowestConsumedOffsets(page1.rows)[0] // exclusive upper for page 2

	// Page 2 continues just below the lowest offset page 1 returned.
	page2Fake := &fakeConsumer{rounds: []kgo.Fetches{
		fetchRound(topic, partitionFetch{partition: 0, highWatermark: 200, records: recordsFor(180, nextUpper)}),
	}}
	page2, err := (&KafkaConnector{consume: page2Fake}).consumeWindows(
		context.Background(), topic, map[int32]partitionWindow{0: {from: 180, upper: nextUpper}}, 100, time.Second)
	if err != nil {
		t.Fatalf("page 2: %v", err)
	}

	seen := make(map[int64]bool, len(page1.rows)+len(page2.rows))
	for _, row := range page1.rows {
		seen[rowOffset(t, row)] = true
	}
	for _, row := range page2.rows {
		off := rowOffset(t, row)
		if seen[off] {
			t.Fatalf("offset %d was returned on both pages", off)
		}
		seen[off] = true
	}
	// Nothing between the two windows may be skipped: [180,200) must be covered.
	for off := int64(180); off < 200; off++ {
		if !seen[off] {
			t.Fatalf("offset %d was skipped across pages", off)
		}
	}
}
