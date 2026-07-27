package kafka

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/twmb/franz-go/pkg/kadm"
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

	added        []map[string]map[int32]kgo.Offset
	removed      []map[string][]int32
	paused       [][]int32
	resumed      []map[string][]int32
	purgedTopics []string
}

func (f *fakeConsumer) PurgeTopicsFromConsuming(topics ...string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.purgedTopics = append(f.purgedTopics, topics...)
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
	page := finalizeRows(selectDirectionalPrefixes(res.rows, pageSize, directionNewest))
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

// resolveScanConsume is the content-search path's adapter over a consumeWindows
// (result, error) pair. The normal-browse path treats "read budget expired before
// any partition finished" as a hard ErrTimeout, but a progressive scan step must
// degrade that one case to an empty partial scan (HTTP 200, partial_scan=true, 0
// matches) so the frontend's "Scan more" loop keeps going. Every OTHER error —
// including a genuine broker RequestTimedOut that also maps to ErrTimeout — must
// still propagate so real failures never masquerade as an empty scan.
//
// This is the coverage for the scanning-path regression fix: without it, a slow
// broker draining scanTimeBudget with zero scoped partitions finished surfaced an
// error banner and halted the scan loop instead of continuing gracefully.
func TestResolveScanConsumeDegradesZeroCompletedBudgetTimeout(t *testing.T) {
	t.Parallel()

	const topic = "orders"

	t.Run("zero-completed budget timeout degrades to an empty partial scan", func(t *testing.T) {
		t.Parallel()
		// A broker that never returns records nor reaches any window end spends the
		// whole scan budget without a single completed partition — consumeWindows
		// returns errReadBudgetExhausted (the same edge the normal path errors on).
		_, budgetErr := (&KafkaConnector{consume: &fakeConsumer{}}).consumeWindows(
			context.Background(), topic,
			map[int32]partitionWindow{0: {from: 0, upper: 10}, 1: {from: 0, upper: 10}},
			maxScanMessages, 120*time.Millisecond,
		)
		if budgetErr == nil {
			t.Fatalf("expected consumeWindows to error on a zero-completed budget timeout")
		}
		if !errors.Is(budgetErr, connector.ErrTimeout) {
			t.Fatalf("the budget-exhausted sentinel must still wrap ErrTimeout, got %v", budgetErr)
		}

		consumed, err := resolveScanConsume(nil, budgetErr)
		if err != nil {
			t.Fatalf("the scan path must tolerate a zero-completed budget timeout, got error: %v", err)
		}
		if consumed == nil {
			t.Fatalf("a degraded scan must return a non-nil result, not (nil, nil)")
		}
		if !consumed.timedOut {
			t.Fatalf("a degraded scan result must be flagged timedOut so meta[partial_scan] is set")
		}
		if len(consumed.rows) != 0 {
			t.Fatalf("a degraded scan result must carry zero rows, got %d", len(consumed.rows))
		}
	})

	t.Run("genuine broker auth error still propagates", func(t *testing.T) {
		t.Parallel()
		_, authErr := (&KafkaConnector{consume: &fakeConsumer{rounds: []kgo.Fetches{
			fetchRound(topic, partitionFetch{partition: 0, err: kerr.TopicAuthorizationFailed}),
		}}}).consumeWindows(
			context.Background(), topic,
			map[int32]partitionWindow{0: {from: 0, upper: 10}},
			maxScanMessages, time.Second,
		)
		if authErr == nil {
			t.Fatalf("expected consumeWindows to surface the broker auth failure")
		}
		res, err := resolveScanConsume(nil, authErr)
		if !errors.Is(err, connector.ErrForbidden) {
			t.Fatalf("a genuine broker/auth error must still propagate from the scan path, got %v", err)
		}
		if res != nil {
			t.Fatalf("a propagated error must not carry a (degraded) result, got %#v", res)
		}
	})

	t.Run("client-closed unavailability still propagates", func(t *testing.T) {
		t.Parallel()
		_, closedErr := (&KafkaConnector{consume: &fakeConsumer{clientClosed: true}}).consumeWindows(
			context.Background(), topic,
			map[int32]partitionWindow{0: {from: 0, upper: 10}},
			maxScanMessages, time.Second,
		)
		if _, err := resolveScanConsume(nil, closedErr); !errors.Is(err, connector.ErrUnavailable) {
			t.Fatalf("a client-closed error must still propagate from the scan path, got %v", err)
		}
	})

	t.Run("a genuine broker timeout that is not the sentinel still propagates", func(t *testing.T) {
		t.Parallel()
		// normalizeKafkaError maps a broker RequestTimedOut / deadline to ErrTimeout
		// too, so the distinction cannot be "any ErrTimeout degrades". Only the
		// errReadBudgetExhausted sentinel does; a different ErrTimeout must error out.
		brokerTimeout := fmt.Errorf("%w: broker request timed out", connector.ErrTimeout)
		res, err := resolveScanConsume(nil, brokerTimeout)
		if err == nil {
			t.Fatalf("a non-sentinel ErrTimeout must still propagate, got result %#v", res)
		}
		if !errors.Is(err, connector.ErrTimeout) {
			t.Fatalf("the propagated error must be the original broker timeout, got %v", err)
		}
	})

	t.Run("a successful result passes through untouched", func(t *testing.T) {
		t.Parallel()
		in := &consumeResult{
			rows:      []map[string]any{{"partition": int32(0), "offset": int64(1)}},
			completed: map[int32]bool{0: true},
		}
		out, err := resolveScanConsume(in, nil)
		if err != nil {
			t.Fatalf("a nil error must pass through, got %v", err)
		}
		if out != in {
			t.Fatalf("a successful result must pass through unchanged")
		}
	})
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

// Once the page target is met, a straggling partition must not hold the response
// for the rest of the read budget: the poll loop waits completionGrace and then
// returns a full page. Such a return is NOT a degraded read, so it must report
// neither partial nor timedOut — otherwise callers would mark a complete answer
// as a shortfall. A budget shorter than the grace still has to be classified as
// a genuine timeout, which pins the order of the two checks in the poll loop.
func TestConsumeWindowsReturnsEarlyOncePageIsSatisfied(t *testing.T) {
	t.Parallel()

	const topic = "orders"
	// Partition 0 completes its window and alone satisfies a 2-row page.
	// Partition 1 needs offset 49, never delivers it, and so stays outstanding.
	newFake := func() *fakeConsumer {
		return &fakeConsumer{rounds: []kgo.Fetches{
			fetchRound(topic,
				partitionFetch{partition: 0, highWatermark: 3, records: []*kgo.Record{
					fetchRecord(topic, 0, 1, `{"n":1}`),
					fetchRecord(topic, 0, 2, `{"n":2}`),
				}},
				partitionFetch{partition: 1, highWatermark: 50, records: []*kgo.Record{
					fetchRecord(topic, 1, 40, `{"n":40}`),
				}},
			),
		}}
	}
	windows := map[int32]partitionWindow{
		0: {from: 1, upper: 3},
		1: {from: 40, upper: 50},
	}

	tests := []struct {
		name              string
		target            int
		budget            time.Duration
		wantPageSatisfied bool
		wantPartial       bool
		wantMaxElapsed    time.Duration
	}{
		{
			// The page is full, so the grace — not the budget — bounds the wait.
			name:              "page satisfied returns on grace, not budget",
			target:            2,
			budget:            5 * time.Second,
			wantPageSatisfied: true,
			wantPartial:       false,
			wantMaxElapsed:    2 * time.Second,
		},
		{
			// The page is short, so the straggler is worth waiting the full budget
			// for and the result is a genuine partial read.
			name:              "page short still waits the budget and reports partial",
			target:            100,
			budget:            300 * time.Millisecond,
			wantPageSatisfied: false,
			wantPartial:       true,
			wantMaxElapsed:    2 * time.Second,
		},
		{
			// Budget below the grace: the read budget check must win, so this is a
			// timeout rather than a satisfied page.
			name:              "budget shorter than grace is a timeout",
			target:            2,
			budget:            completionGrace / 4,
			wantPageSatisfied: false,
			wantPartial:       true,
			wantMaxElapsed:    2 * time.Second,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			conn := &KafkaConnector{consume: newFake()}

			start := time.Now()
			res, err := conn.consumeWindows(context.Background(), topic, windows, tc.target, tc.budget)
			elapsed := time.Since(start)
			if err != nil {
				t.Fatalf("consumeWindows: %v", err)
			}

			if res.pageSatisfied != tc.wantPageSatisfied {
				t.Errorf("pageSatisfied = %v, want %v", res.pageSatisfied, tc.wantPageSatisfied)
			}
			if res.partial != tc.wantPartial {
				t.Errorf("partial = %v, want %v", res.partial, tc.wantPartial)
			}
			if res.timedOut == tc.wantPageSatisfied {
				t.Errorf("timedOut = %v, must be the inverse of pageSatisfied (%v)", res.timedOut, tc.wantPageSatisfied)
			}
			if elapsed > tc.wantMaxElapsed {
				t.Errorf("took %v, want under %v", elapsed, tc.wantMaxElapsed)
			}

			// Regardless of why the loop stopped, only the completed partition's rows
			// may be returned and the outstanding partition must stay incomplete so
			// computeFrontier leaves its cursor pinned.
			if !res.completed[0] {
				t.Errorf("partition 0 should have completed")
			}
			if res.completed[1] {
				t.Errorf("partition 1 should have stayed incomplete")
			}
			if len(res.rows) != 2 {
				t.Errorf("rows = %d, want the 2 rows from the completed partition", len(res.rows))
			}
		})
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

// candidatesRead (Task 3's DataResult.Meta["candidates_read"]) must count every
// raw record actually read off the broker, including records belonging to a
// partition that never completes within budget — those records were still
// real broker reads/decodes, even though their partition's rows are discarded.
func TestConsumeWindowsCountsCandidatesReadIncludingIncompletePartitions(t *testing.T) {
	t.Parallel()

	const topic = "orders"
	fake := &fakeConsumer{rounds: []kgo.Fetches{
		fetchRound(topic,
			// Partition 0 completes cleanly: 2 records read, 2 candidates.
			partitionFetch{partition: 0, highWatermark: 3, records: []*kgo.Record{
				fetchRecord(topic, 0, 1, `{"n":1}`),
				fetchRecord(topic, 0, 2, `{"n":2}`),
			}},
			// Partition 1 delivers one record but never reaches its window end, so
			// it stays incomplete when the budget expires. Its one record was still
			// read off the broker and must count toward candidatesRead even though
			// it never survives into result.rows.
			partitionFetch{partition: 1, highWatermark: 50, records: []*kgo.Record{
				fetchRecord(topic, 1, 40, `{"n":40}`),
			}},
		),
	}}
	conn := &KafkaConnector{consume: fake}

	windows := map[int32]partitionWindow{
		0: {from: 1, upper: 3},
		1: {from: 40, upper: 50},
	}
	res, err := conn.consumeWindows(context.Background(), topic, windows, 100, 150*time.Millisecond)
	if err != nil {
		t.Fatalf("consumeWindows: %v", err)
	}
	if !res.partial {
		t.Fatalf("expected partial=true when partition 1 misses the budget")
	}
	if res.candidatesRead != 3 {
		t.Fatalf("expected 3 candidates read (2 completed + 1 discarded), got %d", res.candidatesRead)
	}
	if len(res.rows) != 2 {
		t.Fatalf("expected only partition 0's 2 rows to survive, got %d", len(res.rows))
	}
}

// completedWindow must record the completed window's lower bound only for
// partitions that actually completed in this call, keyed exactly like
// completed. This is the bookkeeping computeFrontier relies on to advance the
// cursor for a completed-but-empty partition.
func TestConsumeWindowsRecordsCompletedFromForCompletedPartitionsOnly(t *testing.T) {
	t.Parallel()

	const topic = "orders"
	fake := &fakeConsumer{rounds: []kgo.Fetches{
		fetchRound(topic,
			// Partition 0 completes with zero records: a cleanly drained/empty
			// range. Its highWatermark already covers the window end.
			partitionFetch{partition: 0, highWatermark: 10},
			// Partition 1 never completes within the short budget.
			partitionFetch{partition: 1, highWatermark: 50, records: []*kgo.Record{
				fetchRecord(topic, 1, 40, `{"n":40}`),
			}},
		),
	}}
	conn := &KafkaConnector{consume: fake}

	windows := map[int32]partitionWindow{
		0: {from: 5, upper: 10},
		1: {from: 40, upper: 50},
	}
	res, err := conn.consumeWindows(context.Background(), topic, windows, 100, 150*time.Millisecond)
	if err != nil {
		t.Fatalf("consumeWindows: %v", err)
	}
	if !res.completed[0] {
		t.Fatalf("expected partition 0 to complete")
	}
	if res.completed[1] {
		t.Fatalf("expected partition 1 to remain incomplete")
	}
	if window, ok := res.completedWindow[0]; !ok || window.from != 5 {
		t.Fatalf("expected completedWindow[0].from = 5, got %v (present=%v)", window, ok)
	}
	if _, ok := res.completedWindow[1]; ok {
		t.Fatalf("completedWindow must not carry an entry for an incomplete partition, got %v", res.completedWindow[1])
	}
	// recordsRead is completedWindow's companion: it must stay UNSET for a window
	// that completed with zero records, which is exactly what makes the
	// completedWindow advance safe for that partition.
	if res.recordsRead[0] {
		t.Fatalf("partition 0 completed with zero records — recordsRead[0] must stay false")
	}
	if res.recordsRead[1] {
		t.Fatalf("partition 1 never completed — recordsRead[1] must stay false")
	}
}

// The companion of the test above: when a completed window DID contain records,
// recordsRead must be set, so computeFrontier can refuse the completedWindow
// advance and avoid skipping records that may not survive page selection.
func TestConsumeWindowsMarksRecordsReadForNonEmptyCompletedWindow(t *testing.T) {
	t.Parallel()

	const topic = "orders"
	fake := &fakeConsumer{rounds: []kgo.Fetches{
		fetchRound(topic,
			// Partition 0 completes with records inside its window.
			partitionFetch{partition: 0, highWatermark: 10, records: []*kgo.Record{
				fetchRecord(topic, 0, 8, `{"n":8}`),
				fetchRecord(topic, 0, 9, `{"n":9}`),
			}},
			// Partition 1 completes with zero records (empty/compacted range).
			partitionFetch{partition: 1, highWatermark: 50},
		),
	}}
	conn := &KafkaConnector{consume: fake}

	windows := map[int32]partitionWindow{
		0: {from: 5, upper: 10},
		1: {from: 45, upper: 50},
	}
	res, err := conn.consumeWindows(context.Background(), topic, windows, 100, 150*time.Millisecond)
	if err != nil {
		t.Fatalf("consumeWindows: %v", err)
	}
	if !res.recordsRead[0] {
		t.Fatalf("partition 0's completed window held 2 records — recordsRead[0] must be true")
	}
	if res.recordsRead[1] {
		t.Fatalf("partition 1's completed window held no record — recordsRead[1] must be false")
	}
	// Both still record completedWindow; recordsRead is the discriminator, not
	// completedWindow's presence.
	if window, ok := res.completedWindow[0]; !ok || window.from != 5 {
		t.Fatalf("expected completedWindow[0].from = 5, got %v (present=%v)", window, ok)
	}
	if window, ok := res.completedWindow[1]; !ok || window.from != 45 {
		t.Fatalf("expected completedWindow[1].from = 45, got %v (present=%v)", window, ok)
	}
}

// computeFrontier is the pure function behind GetData's pagination cursor. It
// must satisfy TWO opposing requirements at once:
//
//   - Task 3's stuck-cursor fix: a completed partition that contained zero
//     records (an empty/compacted window) must still advance its cursor via
//     completedWindow, otherwise the exact same empty window would be rescanned
//     forever by "Load older" / "Scan more" (partition 1 below).
//   - The silent-skip fix: a completed partition that DID contain records, none
//     of which survived the final page trim, must NOT advance — advancing there
//     moves the cursor past records that were read from the broker but never
//     returned, losing them permanently (partition 3 below).
//
// recordsRead is what separates the two; both are asserted here so neither fix
// can be regressed without failing this test.
func TestComputeFrontierAdvancesCompletedEmptyPartitions(t *testing.T) {
	t.Parallel()

	frontierWindows := map[int32]partitionWindow{
		0: {from: 0, upper: 100}, // has rows: row-based cursor wins
		1: {from: 0, upper: 50},  // completed with zero records: completedWindow wins
		2: {from: 0, upper: 30},  // neither rows nor completedWindow: stays at upper
		3: {from: 0, upper: 40},  // completed WITH records, all trimmed: stays at upper
	}
	rows := []map[string]any{
		{"partition": int32(0), "offset": int64(90)},
		{"partition": int32(0), "offset": int64(95)},
	}
	completed := map[int32]bool{0: true, 1: true, 3: true}
	completedWindow := map[int32]partitionWindow{0: {from: 80, upper: 100}, 1: {from: 20, upper: 50}, 3: {from: 15, upper: 40}} // 0's window must lose to its rows
	recordsRead := map[int32]bool{0: true, 3: true}

	frontier := computeFrontier(frontierWindows, rows, false, directionNewest, completed, completedWindow, recordsRead)

	if frontier[0] != 90 {
		t.Fatalf("partition 0: row-based cursor must win over completedWindow, got %d, want 90", frontier[0])
	}
	if frontier[1] != 20 {
		t.Fatalf("partition 1: completed-but-empty partition must advance via completedWindow, got %d, want 20", frontier[1])
	}
	if frontier[2] != 30 {
		t.Fatalf("partition 2: untouched partition must keep its prior upper offset, got %d, want 30", frontier[2])
	}
	if frontier[3] != 40 {
		t.Fatalf("partition 3: a completed window whose records were all trimmed out of the page must NOT "+
			"advance past them (that is silent data loss), got %d, want 40", frontier[3])
	}
}

// The scanning path only trusts a row's offset as a cursor advance when its
// partition is marked completed (an in-flight, not-yet-finished partition's
// rows must not move the cursor past data that hasn't been confirmed safe).
func TestComputeFrontierScanningRequiresCompletionForRowBasedAdvance(t *testing.T) {
	t.Parallel()

	frontierWindows := map[int32]partitionWindow{
		0: {from: 0, upper: 100},
	}
	rows := []map[string]any{
		{"partition": int32(0), "offset": int64(90)},
	}

	// Partition 0 not completed: row-based advance must NOT apply.
	frontier := computeFrontier(frontierWindows, rows, true, directionNewest, map[int32]bool{}, map[int32]partitionWindow{}, map[int32]bool{})
	if frontier[0] != 100 {
		t.Fatalf("scanning: an incomplete partition's rows must not advance the cursor, got %d, want 100", frontier[0])
	}

	// Partition 0 completed: row-based advance applies.
	frontier = computeFrontier(frontierWindows, rows, true, directionNewest, map[int32]bool{0: true}, map[int32]partitionWindow{}, map[int32]bool{0: true})
	if frontier[0] != 90 {
		t.Fatalf("scanning: a completed partition's rows must advance the cursor, got %d, want 90", frontier[0])
	}
}

// buildPaginationCursor must keep a partition that fully drained THIS request
// (frontier == start) in next_before_offsets at its start offset rather than
// dropping it, and derive has_older from whether ANY partition still has older data
// (frontier > start), not from the map's size. This is the exact regression: the
// pre-fix code omitted a drained partition, so the next request — seeing no cursor
// entry for it — re-read that partition from the current end offset and re-showed
// its rows, and has_older (then len(map) > 0) never reached false while any deeper
// partition remained.
func TestBuildPaginationCursorRetainsDrainedPartitionsAndDerivesHasOlder(t *testing.T) {
	t.Parallel()

	// Partition 0 (deep) still has older data below offset 10; partition 52 (shallow)
	// drained THIS request down to its start offset 0. Both had a window, so both are
	// present in frontier.
	scoped := []int32{0, 52}
	frontier := map[int32]int64{0: 10, 52: 0}
	// Every partition here spans [0, 100): start 0, end 100.
	boundsOf := func(int32) (int64, int64) { return 0, 100 }

	cursor, hasOlder := buildPaginationCursor(scoped, frontier, nil, directionNewest, boundsOf)

	if got, ok := cursor["52"]; !ok || got != 0 {
		t.Fatalf("drained partition 52 must be retained at its start offset 0 (present=%v, value=%d); "+
			"omitting it makes the next request re-read it from the top", ok, got)
	}
	if got, ok := cursor["0"]; !ok || got != 10 {
		t.Fatalf("partition 0 must carry its frontier offset 10, got %d (present=%v)", got, ok)
	}
	if !hasOlder {
		t.Fatalf("has_older must be true while partition 0 still has older data (frontier 10 > start 0)")
	}
}

// The page AFTER a partition drains, that partition is no longer windowed (its
// window builder hits upper <= low and skips it), so it is absent from frontier.
// buildPaginationCursor must still carry it forward — pinned at its start offset —
// from the incoming cursor, or it drops out of next_before_offsets and the request
// after that re-reads it from the top. This is the second half of the same bug: the
// live QA sweep saw partition 52 drain on page 6, get pinned on page 6, then vanish
// from page 7's cursor (52 no longer windowed) and be re-read on page 8 (52:11
// duplicate). Carrying it forward from beforeOffsets fixes that.
func TestBuildPaginationCursorCarriesForwardAlreadyDrainedPartition(t *testing.T) {
	t.Parallel()

	// Partition 0 windowed with older data still remaining; partition 52 drained on a
	// prior page (NOT windowed this request, so absent from frontier) but present in
	// the incoming cursor at its start offset 0.
	scoped := []int32{0, 52}
	frontier := map[int32]int64{0: 10} // only partition 0 had a window this request
	beforeOffsets := map[int32]int64{0: 20, 52: 0}
	// Every partition here spans [0, 100): start 0, end 100.
	boundsOf := func(int32) (int64, int64) { return 0, 100 }

	cursor, hasOlder := buildPaginationCursor(scoped, frontier, beforeOffsets, directionNewest, boundsOf)

	if got, ok := cursor["52"]; !ok || got != 0 {
		t.Fatalf("already-drained partition 52 must be carried forward at its start offset 0 (present=%v, "+
			"value=%d); dropping it makes the NEXT request re-read it from the top", ok, got)
	}
	if got, ok := cursor["0"]; !ok || got != 10 {
		t.Fatalf("partition 0 must carry its frontier offset 10, got %d (present=%v)", got, ok)
	}
	if !hasOlder {
		t.Fatalf("has_older must be true while partition 0 still has older data")
	}
}

// An empty scoped partition (no records, no window, never in the cursor) must be
// omitted entirely — it can never be re-read, so it needs no cursor entry, and
// including it would just grow the map with noise. Also the complement of the
// has_older check: once every partition with data has drained, has_older is false
// even though the map is non-empty (it lists every drained-but-nonempty partition).
func TestBuildPaginationCursorOmitsEmptyAndDerivesHasOlderFalseWhenAllDrained(t *testing.T) {
	t.Parallel()

	// Partitions 0 and 52 held data and have now drained to their start (0); partition
	// 27 is empty (never windowed, never carried a cursor).
	scoped := []int32{0, 27, 52}
	frontier := map[int32]int64{0: 0, 52: 0} // both drained to their start; 27 never had a window
	beforeOffsets := map[int32]int64{0: 2, 52: 2}
	// Every partition here spans [0, 100): start 0, end 100.
	boundsOf := func(int32) (int64, int64) { return 0, 100 }

	cursor, hasOlder := buildPaginationCursor(scoped, frontier, beforeOffsets, directionNewest, boundsOf)

	if hasOlder {
		t.Fatalf("has_older must be false once every scoped partition with data has drained to its start")
	}
	if _, ok := cursor["27"]; ok {
		t.Fatalf("the empty partition 27 must be omitted from the cursor, got %#v", cursor)
	}
	if len(cursor) != 2 {
		t.Fatalf("the cursor must list exactly the two drained-but-nonempty partitions, got %#v", cursor)
	}
}

// snapshotRead must SKIP building a window for a partition whose before_offsets
// cursor sits at exactly its start offset (a partition drained on the previous
// page). Without this, a drained partition retained in the cursor at its start
// would still get a window and be re-read — defeating the buildPaginationCursor
// fix. This proves the consumer side of the cursor contract with no live broker.
func TestSnapshotReadSkipsPartitionWhoseCursorIsAtStart(t *testing.T) {
	t.Parallel()

	const topic = "orders"
	starts := listedOffsets(topic, map[int32]int64{0: 0, 1: 0})
	ends := listedOffsets(topic, map[int32]int64{0: 100, 1: 12})
	// Cursor from the previous page: partition 1 fully drained (cursor == its start
	// offset 0); partition 0 still has older data (cursor at offset 10).
	beforeOffsets := map[int32]int64{0: 10, 1: 0}

	// Only partition 0 is scripted to deliver; partition 1 must never be assigned or
	// read because its window is skipped.
	fake := &fakeConsumer{rounds: []kgo.Fetches{
		fetchRound(topic, partitionFetch{partition: 0, highWatermark: 100, records: []*kgo.Record{
			fetchRecord(topic, 0, 8, `{"n":8}`),
			fetchRecord(topic, 0, 9, `{"n":9}`),
		}}),
	}}
	conn := &KafkaConnector{consume: fake}

	res, frontierWindows, err := conn.snapshotRead(context.Background(), topic, []int32{0, 1}, starts, ends, directionNewest, nil, beforeOffsets, 100)
	if err != nil {
		t.Fatalf("snapshotRead: %v", err)
	}
	if _, ok := frontierWindows[1]; ok {
		t.Fatalf("partition 1 (cursor at its start offset) must NOT get a window — a window means it "+
			"would be re-read from offset %d down, re-showing already-returned rows", ends[topic][1].Offset)
	}
	if _, ok := frontierWindows[0]; !ok {
		t.Fatalf("partition 0 still has older data and must get a window")
	}
	// The reader must never have asked the broker to consume partition 1.
	fake.mu.Lock()
	added := fake.added
	fake.mu.Unlock()
	for _, assignment := range added {
		if parts, ok := assignment[topic]; ok {
			if _, has := parts[1]; has {
				t.Fatalf("drained partition 1 must never be assigned for consumption, got assignment %#v", parts)
			}
		}
	}
	// Sanity: partition 0's window was read (offsets 8,9), confirming the read
	// actually happened rather than the whole call short-circuiting.
	if len(res.rows) != 2 {
		t.Fatalf("expected partition 0's 2 rows to be read, got %d", len(res.rows))
	}
}

// pageFrontier replays GetData's exact post-consume sequence (trim to the page
// limit, sort newest-first, derive the cursor) so a test can assert the cursor a
// real request would emit without a live broker or the metadata round-trips.
func pageFrontier(consumed *consumeResult, frontierWindows map[int32]partitionWindow, limit int) ([]map[string]any, map[int32]int64) {
	rows := selectDirectionalPrefixes(consumed.rows, limit, directionNewest)
	sortRowsDirectional(rows, directionNewest)
	return rows, computeFrontier(frontierWindows, rows, false, directionNewest, consumed.completed, consumed.completedWindow, consumed.recordsRead)
}

// rowsContain reports whether the page holds a specific (partition, offset).
func rowsContain(rows []map[string]any, partition int32, offset int64) bool {
	for _, row := range rows {
		id, _ := row["partition"].(int32)
		off, _ := row["offset"].(int64)
		if id == partition && off == offset {
			return true
		}
	}
	return false
}

// THE SILENT-SKIP REGRESSION. A partition can complete its window and yield
// records that are then ALL trimmed out of the final page by selectNewestPrefixes
// (its records are older than other partitions'). Before the fix, computeFrontier
// saw no rows for it in the trimmed page and fell through to the completedWindow
// advance, moving the cursor BELOW records that were read from the broker but
// never returned — permanently unreachable data loss. Live evidence: the QA sweep
// saw 749 of 785 seeded messages (3 partitions x 12 records skipped).
//
// The invariant: a partition's cursor may only advance past an offset that was
// either RETURNED in this response, or confirmed to hold no record at all.
func TestSnapshotReadDoesNotAdvanceCursorPastRecordsWithheldFromPage(t *testing.T) {
	t.Parallel()

	const topic = "orders"
	const limit = 4
	// Three scoped partitions => per-partition quota ceil(4/3) = 2, so one round
	// reads 6 candidates for a 4-row page: 2 candidates must be trimmed.
	starts := listedOffsets(topic, map[int32]int64{0: 0, 1: 0, 2: 0})
	ends := listedOffsets(topic, map[int32]int64{0: 100, 1: 100, 2: 12})

	// Partitions 0 and 1 sit at the newest offsets (fetchRecord derives the record
	// timestamp from the offset, so higher offset == newer). Partition 2 is a
	// shallow, much older tail: its two records complete its window but lose the
	// newest-4 selection outright.
	fake := &fakeConsumer{rounds: []kgo.Fetches{
		fetchRound(topic,
			partitionFetch{partition: 0, highWatermark: 100, records: []*kgo.Record{
				fetchRecord(topic, 0, 98, `{"n":98}`),
				fetchRecord(topic, 0, 99, `{"n":99}`),
			}},
			partitionFetch{partition: 1, highWatermark: 100, records: []*kgo.Record{
				fetchRecord(topic, 1, 98, `{"n":98}`),
				fetchRecord(topic, 1, 99, `{"n":99}`),
			}},
			partitionFetch{partition: 2, highWatermark: 12, records: []*kgo.Record{
				fetchRecord(topic, 2, 10, `{"n":10}`),
				fetchRecord(topic, 2, 11, `{"n":11}`),
			}},
		),
	}}
	conn := &KafkaConnector{consume: fake}

	consumed, frontierWindows, err := conn.snapshotRead(context.Background(), topic, []int32{0, 1, 2}, starts, ends, directionNewest, nil, nil, limit)
	if err != nil {
		t.Fatalf("snapshotRead: %v", err)
	}
	if !consumed.completed[2] {
		t.Fatalf("precondition: partition 2 must complete its window, got %#v", consumed.completed)
	}
	if window, ok := consumed.completedWindow[2]; !ok || window.from != 10 {
		t.Fatalf("precondition: partition 2 must record completedWindow.from=10, got %v (present=%v)", window, ok)
	}
	if len(consumed.rows) != 6 {
		t.Fatalf("precondition: expected 6 candidates read across 3 partitions, got %d", len(consumed.rows))
	}

	rows, frontier := pageFrontier(consumed, frontierWindows, limit)

	if len(rows) != limit {
		t.Fatalf("precondition: expected a full %d-row page, got %d", limit, len(rows))
	}
	// Partition 2's records were read but WITHHELD from the page — the exact
	// setup that used to lose them.
	if rowsContain(rows, 2, 10) || rowsContain(rows, 2, 11) {
		t.Fatalf("precondition: partition 2's records must be trimmed out of the page, got %#v", rows)
	}
	if frontier[2] != 12 {
		t.Fatalf("SILENT SKIP: partition 2's cursor advanced to %d, past records 10 and 11 that were read "+
			"from the broker but never returned to the caller — they can never be fetched again. "+
			"It must stay at its prior upper offset 12 so the next page re-reads that window.", frontier[2])
	}
	// The returned partitions advance normally (their newest prefix is in the page).
	if frontier[0] != 98 || frontier[1] != 98 {
		t.Fatalf("returned partitions must advance to their lowest returned offset, got 0=%d 1=%d (want 98, 98)",
			frontier[0], frontier[1])
	}
}

// The adaptive-rounds aggregation caveat. completedWindow deepens with every
// widening round, so a LATER round that reads a genuinely empty deeper window
// must not let the cursor leapfrog past records an EARLIER round of the SAME
// request read and withheld from the page. recordsRead is therefore sticky
// (OR-ed across rounds), never overwritten the way completed/completedWindow are.
func TestSnapshotReadLaterEmptyRoundCannotLeapfrogEarlierWithheldRecords(t *testing.T) {
	t.Parallel()

	const topic = "orders"
	const limit = 4
	starts := listedOffsets(topic, map[int32]int64{0: 0, 1: 0})
	ends := listedOffsets(topic, map[int32]int64{0: 100, 1: 20})

	fake := &fakeConsumer{rounds: []kgo.Fetches{
		// Round 1 (quota 2 per partition): partition 0 reads [98,100) and partition 1
		// reads [18,20). Each yields a single record, so the 4-row page under-fills
		// and a widening round follows. Partition 1's record at offset 19 is the one
		// that must never be skipped.
		fetchRound(topic,
			partitionFetch{partition: 0, highWatermark: 100, records: []*kgo.Record{
				fetchRecord(topic, 0, 99, `{"n":99}`),
			}},
			partitionFetch{partition: 1, highWatermark: 20, records: []*kgo.Record{
				fetchRecord(topic, 1, 19, `{"n":19}`),
			}},
		),
		// Round 2 widens to 4: partition 0 reads [94,98) and fills the page; partition
		// 1's deeper window [14,18) is genuinely EMPTY (high watermark already past its
		// upper bound), so it completes with zero records and records completedWindow=14.
		// Taken alone that is a legitimate advance — but partition 1's offset-19 record
		// from round 1 sits ABOVE it and is about to be trimmed off the page.
		fetchRound(topic,
			partitionFetch{partition: 0, highWatermark: 100, records: []*kgo.Record{
				fetchRecord(topic, 0, 94, `{"n":94}`),
				fetchRecord(topic, 0, 95, `{"n":95}`),
				fetchRecord(topic, 0, 96, `{"n":96}`),
				fetchRecord(topic, 0, 97, `{"n":97}`),
			}},
			partitionFetch{partition: 1, highWatermark: 20},
		),
	}}
	conn := &KafkaConnector{consume: fake}

	consumed, frontierWindows, err := conn.snapshotRead(context.Background(), topic, []int32{0, 1}, starts, ends, directionNewest, nil, nil, limit)
	if err != nil {
		t.Fatalf("snapshotRead: %v", err)
	}
	// Precondition: the later empty round did deepen completedWindow for partition 1.
	if window, ok := consumed.completedWindow[1]; !ok || window.from != 14 {
		t.Fatalf("precondition: round 2 must deepen completedWindow[1].from to 14, got %v (present=%v)", window, ok)
	}
	if !consumed.recordsRead[1] {
		t.Fatalf("recordsRead must be sticky across rounds: round 1 read a record for partition 1")
	}

	rows, frontier := pageFrontier(consumed, frontierWindows, limit)

	if rowsContain(rows, 1, 19) {
		t.Fatalf("precondition: partition 1's offset-19 record must be trimmed out of the page, got %#v", rows)
	}
	if frontier[1] != 20 {
		t.Fatalf("LEAPFROG: partition 1's cursor advanced to %d, past the offset-19 record that round 1 read "+
			"and this page withheld. It must stay at its prior upper offset 20.", frontier[1])
	}
}

// listedOffsets builds a kadm.ListedOffsets for one topic from a partition->offset
// map, so snapshotRead can be driven directly in a unit test without a live broker.
func listedOffsets(topic string, byPartition map[int32]int64) kadm.ListedOffsets {
	inner := make(map[int32]kadm.ListedOffset, len(byPartition))
	for id, off := range byPartition {
		inner[id] = kadm.ListedOffset{Topic: topic, Partition: id, Offset: off}
	}
	return kadm.ListedOffsets{topic: inner}
}

// snapshotRead's partitions_completed count (len(consumed.completed), surfaced as
// Meta["partitions_completed"]) must never equal partitions_total (len(scoped))
// while the response is flagged partial. This guards the common adaptive-widening
// partial path: round 1 completes ALL scoped partitions with a shallow quota, the
// page under-fills, then a deeper widening round is cut short by the budget and
// returns partial (some partitions complete, some don't). A permissive cross-round
// union of completed would leave every partition marked completed even though the
// response is partial — a self-contradictory "N of N partitions responded" next to
// a partial badge. Each round must instead be authoritative for the partitions it
// re-attempts, so a partition widened into again and cut off flips back to
// not-completed for this response.
func TestSnapshotReadPartialNeverReportsAllPartitionsCompleted(t *testing.T) {
	t.Parallel()

	const topic = "orders"
	// Partitions 0 and 1 have a deep backlog (start 0); partition 2 is a shallow
	// tail (start 980) that round 1 fully drains, so it is never re-attempted.
	starts := listedOffsets(topic, map[int32]int64{0: 0, 1: 0, 2: 980})
	ends := listedOffsets(topic, map[int32]int64{0: 1000, 1: 1000, 2: 1000})

	fake := &fakeConsumer{rounds: []kgo.Fetches{
		// Round 1: every scoped partition completes its shallow window via an empty
		// end fetch (high watermark already covers the window), contributing zero
		// rows — the page under-fills, forcing a widening round.
		fetchRound(topic,
			partitionFetch{partition: 0, highWatermark: 1000},
			partitionFetch{partition: 1, highWatermark: 1000},
			partitionFetch{partition: 2, highWatermark: 1000},
		),
		// Round 2 widens partitions 0 and 1 (partition 2 is fully drained). Partition
		// 0 completes (record at its window's upper-1); partition 1 delivers a record
		// but never reaches its end, so it stays incomplete until the budget expires
		// and consumeWindows returns a partial (non-error) round.
		fetchRound(topic,
			partitionFetch{partition: 0, highWatermark: 1000, records: []*kgo.Record{
				fetchRecord(topic, 0, 965, `{"n":965}`),
			}},
			partitionFetch{partition: 1, highWatermark: 1000, records: []*kgo.Record{
				fetchRecord(topic, 1, 900, `{"n":900}`),
			}},
		),
	}}
	conn := &KafkaConnector{consume: fake}

	// A short deadline forces round 2's widened read to be cut short by the budget.
	ctx, cancel := context.WithTimeout(context.Background(), 150*time.Millisecond)
	defer cancel()

	scoped := []int32{0, 1, 2}
	res, _, err := conn.snapshotRead(ctx, topic, scoped, starts, ends, directionNewest, nil, nil, 100)
	if err != nil {
		t.Fatalf("snapshotRead: %v", err)
	}
	if !res.partial {
		t.Fatalf("expected a partial response when a widened round is cut off by the budget")
	}
	// The invariant: a partial response can never claim every scoped partition
	// completed.
	if len(res.completed) >= len(scoped) {
		t.Fatalf("partial response reported partitions_completed=%d >= partitions_total=%d (self-contradictory)",
			len(res.completed), len(scoped))
	}
	// Concretely: partition 2 (fully drained in round 1, never re-attempted) stays
	// completed; partition 0 completes again in round 2; partition 1 was re-attempted
	// and cut off, so it flips back to not-completed.
	if !res.completed[0] {
		t.Fatalf("partition 0 completed round 2 and must stay completed, got %#v", res.completed)
	}
	if res.completed[1] {
		t.Fatalf("partition 1 was widened into and cut off — it must NOT count as completed, got %#v", res.completed)
	}
	if !res.completed[2] {
		t.Fatalf("partition 2 was fully drained in round 1 and never re-attempted — it must stay completed, got %#v", res.completed)
	}
	if len(res.completed) != 2 {
		t.Fatalf("expected exactly 2 completed partitions (0 and 2), got %d: %#v", len(res.completed), res.completed)
	}
}

// The companion to the partial path above: when an ENTIRE widening round errors
// (zero completions that round, e.g. the read budget expires before any widened
// partition finishes) after an earlier round already completed partitions,
// snapshotRead returns the earlier work as a partial page. Every partition
// attempted in the failed round must be excluded from partitions_completed too —
// snapshotRead knows them from its own local `windows` map even though
// consumeWindows returned an error, not a *consumeResult. Without this, the
// error branch would keep the prior round's stale completed union and again report
// partitions_completed == partitions_total on a partial response.
func TestSnapshotReadPartialAfterErroredRoundExcludesAttemptedPartitions(t *testing.T) {
	t.Parallel()

	const topic = "orders"
	starts := listedOffsets(topic, map[int32]int64{0: 0, 1: 0, 2: 980})
	ends := listedOffsets(topic, map[int32]int64{0: 1000, 1: 1000, 2: 1000})

	fake := &fakeConsumer{rounds: []kgo.Fetches{
		// Round 1: all three scoped partitions complete cleanly with zero rows, so
		// the page under-fills and a widening round is required.
		fetchRound(topic,
			partitionFetch{partition: 0, highWatermark: 1000},
			partitionFetch{partition: 1, highWatermark: 1000},
			partitionFetch{partition: 2, highWatermark: 1000},
		),
		// Round 2 widens partitions 0 and 1 (partition 2 is fully drained). No round
		// is scripted for it, so the fake blocks until the deadline and consumeWindows
		// returns errReadBudgetExhausted — zero completions that round.
	}}
	conn := &KafkaConnector{consume: fake}

	ctx, cancel := context.WithTimeout(context.Background(), 150*time.Millisecond)
	defer cancel()

	scoped := []int32{0, 1, 2}
	res, _, err := conn.snapshotRead(ctx, topic, scoped, starts, ends, directionNewest, nil, nil, 100)
	if err != nil {
		t.Fatalf("snapshotRead must return the earlier round's work as a partial page, not an error: %v", err)
	}
	if !res.partial {
		t.Fatalf("expected a partial response when the widening round's budget is exhausted")
	}
	if len(res.completed) >= len(scoped) {
		t.Fatalf("partial response reported partitions_completed=%d >= partitions_total=%d (self-contradictory)",
			len(res.completed), len(scoped))
	}
	// Partitions 0 and 1 were attempted in the errored round and must be excluded;
	// partition 2 was fully drained in round 1 and never re-attempted, so it stays.
	if res.completed[0] || res.completed[1] {
		t.Fatalf("partitions attempted in the errored widening round must be excluded from the count, got %#v", res.completed)
	}
	if !res.completed[2] {
		t.Fatalf("the fully-drained partition 2 must stay completed, got %#v", res.completed)
	}
	if len(res.completed) != 1 {
		t.Fatalf("expected exactly 1 completed partition (2), got %d: %#v", len(res.completed), res.completed)
	}
}

// TestConsumeWindowsHandlesOneSlowPartitionAmongManyWithinBudget frames the
// partial-result guarantee as an explicit "one slow broker/partition among many
// healthy ones" scenario — Task 8's slow-partition acceptance check, done as a
// deterministic unit test through the fakeConsumer seam rather than real network
// fault injection (per the plan's scoping decision). It extends
// TestConsumeWindowsReturnsPartialWhenPartitionMissesBudget (a single fast + a
// single slow partition) to SEVERAL fast partitions plus one slow one, and pins
// down three things at once: the reader returns near its budget instead of
// hanging on the slow partition, every fast partition's rows survive, and the
// response is flagged partial=true rather than erroring or discarding the safe
// data.
func TestConsumeWindowsHandlesOneSlowPartitionAmongManyWithinBudget(t *testing.T) {
	t.Parallel()

	const (
		topic     = "orders"
		fastCount = 5
		slowID    = int32(5)
	)
	// Five fast partitions each deliver their full 2-record window (offsets 0,1)
	// in the first poll round, so each reaches its window end and completes. One
	// slow partition delivers a single early record but never reaches its window
	// end (it needs offset 199), so it stays unfinished until the read budget fires
	// — exactly the shape of one broker/partition responding slower than the read
	// budget while its peers respond normally.
	parts := make([]partitionFetch, 0, fastCount+1)
	for p := int32(0); p < fastCount; p++ {
		parts = append(parts, partitionFetch{partition: p, highWatermark: 2, records: []*kgo.Record{
			fetchRecord(topic, p, 0, `{"n":0}`),
			fetchRecord(topic, p, 1, `{"n":1}`),
		}})
	}
	parts = append(parts, partitionFetch{partition: slowID, highWatermark: 200, records: []*kgo.Record{
		fetchRecord(topic, slowID, 10, `{"slow":true}`),
	}})
	fake := &fakeConsumer{rounds: []kgo.Fetches{fetchRound(topic, parts...)}}
	conn := &KafkaConnector{consume: fake}

	windows := make(map[int32]partitionWindow, fastCount+1)
	for p := int32(0); p < fastCount; p++ {
		windows[p] = partitionWindow{from: 0, upper: 2}
	}
	windows[slowID] = partitionWindow{from: 0, upper: 200} // needs offset 199, never delivered

	const budget = 150 * time.Millisecond
	start := time.Now()
	res, err := conn.consumeWindows(context.Background(), topic, windows, 100, budget)
	elapsed := time.Since(start)
	if err != nil {
		t.Fatalf("one slow partition among many must be a partial success, not an error: %v", err)
	}
	// Completes near the budget rather than hanging on the slow partition.
	if elapsed > time.Second {
		t.Fatalf("reader must return near its %v budget, took %v", budget, elapsed)
	}
	if !res.partial {
		t.Fatalf("expected partial=true when one partition misses the read budget")
	}
	if !res.timedOut {
		t.Fatalf("expected timedOut=true (budget expired before the slow partition finished)")
	}
	// Every fast partition completed; the slow one did not.
	for p := int32(0); p < fastCount; p++ {
		if !res.completed[p] {
			t.Fatalf("fast partition %d must complete within budget, got completed=%#v", p, res.completed)
		}
	}
	if res.completed[slowID] {
		t.Fatalf("the slow partition %d must remain incomplete, got completed=%#v", slowID, res.completed)
	}
	if len(res.completed) != fastCount {
		t.Fatalf("expected exactly %d completed partitions, got %d: %#v", fastCount, len(res.completed), res.completed)
	}
	// The fast partitions' rows survive; the slow partition's single in-flight
	// record is discarded because its window never completed.
	if want := fastCount * 2; len(res.rows) != want {
		t.Fatalf("expected %d rows from the completed fast partitions, got %d", want, len(res.rows))
	}
	for _, row := range res.rows {
		if p, _ := row["partition"].(int32); p == slowID {
			t.Fatalf("no row from the incomplete slow partition may be returned, got %#v", row)
		}
	}
	// The slow partition's single delivered record still counts as a candidate read.
	if want := fastCount*2 + 1; res.candidatesRead != want {
		t.Fatalf("expected %d candidates read (%d fast + 1 slow), got %d", want, fastCount*2, res.candidatesRead)
	}
}

// BenchmarkNormalBrowseLargePayloads measures the allocation cost of a normal-
// browse page read over a topic whose candidates are almost all large (~128KB)
// JSON payloads, MOST of which are discarded before the final page selection. It
// is the "proper benchmark" extension of
// TestConsumeWindowsDefersDeserializationUntilFinalPage (Task 8a's large-payload /
// deferred-deserialization acceptance item).
//
// Both sub-benchmarks run the full normal-browse page pipeline over an IDENTICAL
// candidate set built once outside the loop, so the only variable is when
// deserialization happens:
//
//   - deferred: the shipped reader path, finalizeRows(selectDirectionalPrefixes(rows,
//     page)). Only the ~page rows that survive selection are ever deserialized;
//     allocation scales with messages_returned × payload.
//   - eager_prerework: a faithful stand-in for the pre-rework reader, which
//     deserialized EVERY candidate before the merge — selectDirectionalPrefixes(
//     finalizeRows(rows), page). Allocation scales with candidates_read × payload.
//
// consumeWindows (the raw-byte copy) is identical in both, so the bytes/op and
// allocs/op DELTA between them is exactly the cost of deserializing the discarded
// candidates — the memory the deferred pipeline avoids. Recorded numbers and the
// before/after scaling analysis live in task-8a-report.md.
func BenchmarkNormalBrowseLargePayloads(b *testing.B) {
	const (
		topic        = "big-payloads-bench"
		partitions   = 6
		perPartition = 100 // 600 candidates total
		pageSize     = 100 // only 100 survive selection; 500 (~83%) are discarded
	)
	largePayload := `{"blob":"` + strings.Repeat("A", 128*1024) + `"}`

	// Build the fetch round once; every record shares the one payload buffer, so
	// the fixture itself is cheap. consumeWindows copies the bytes per candidate at
	// read time, measured identically inside both sub-benchmark loops.
	parts := make([]partitionFetch, 0, partitions)
	for p := int32(0); p < partitions; p++ {
		records := make([]*kgo.Record, 0, perPartition)
		for off := int64(0); off < perPartition; off++ {
			records = append(records, fetchRecord(topic, p, off, largePayload))
		}
		parts = append(parts, partitionFetch{partition: p, highWatermark: perPartition, records: records})
	}
	round := fetchRound(topic, parts...)
	windows := make(map[int32]partitionWindow, partitions)
	for p := int32(0); p < partitions; p++ {
		windows[p] = partitionWindow{from: 0, upper: perPartition}
	}

	// read replays the same scripted round into a fresh reader and returns the raw,
	// undeserialized candidates a normal browse would have consumed.
	read := func(b *testing.B) *consumeResult {
		res, err := (&KafkaConnector{consume: &fakeConsumer{rounds: []kgo.Fetches{round}}}).
			consumeWindows(context.Background(), topic, windows, pageSize, 2*time.Second)
		if err != nil {
			b.Fatalf("consumeWindows: %v", err)
		}
		if want := partitions * perPartition; len(res.rows) != want {
			b.Fatalf("expected %d raw candidates, got %d", want, len(res.rows))
		}
		return res
	}

	b.Run("deferred", func(b *testing.B) {
		b.ReportAllocs()
		for i := 0; i < b.N; i++ {
			res := read(b)
			page := finalizeRows(selectDirectionalPrefixes(res.rows, pageSize, directionNewest))
			if len(page) != pageSize {
				b.Fatalf("expected a %d-row page, got %d", pageSize, len(page))
			}
		}
	})

	b.Run("eager_prerework", func(b *testing.B) {
		b.ReportAllocs()
		for i := 0; i < b.N; i++ {
			res := read(b)
			page := selectDirectionalPrefixes(finalizeRows(res.rows), pageSize, directionNewest)
			if len(page) != pageSize {
				b.Fatalf("expected a %d-row page, got %d", pageSize, len(page))
			}
		}
	})
}

// --- Topic delete/recreate recovery -----------------------------------------
//
// Kafka addresses topics by UUID in fetch requests (KIP-516), and the long-lived
// kgo.Client caches name -> UUID. Recreating a topic with the same name gives it a
// NEW UUID, so the cached mapping is stale and the broker answers UnknownTopicID
// forever. franz-go deliberately bubbles that up instead of retrying (source.go:
// "the topic has been recreated and we will never consume the topic again").
// Before this, the only cure was deleting and recreating the whole connection.

// consumeWindows must surface the stale-topic-ID failure as its own sentinel,
// BEFORE normalizeKafkaError — that helper wraps the message as a string and would
// drop the *kerr.Error from the chain, making the condition undetectable.
func TestConsumeWindowsSurfacesTopicIncarnationChange(t *testing.T) {
	t.Parallel()

	const topic = "orders"
	fake := &fakeConsumer{rounds: []kgo.Fetches{
		fetchRound(topic, partitionFetch{partition: 0, err: kerr.UnknownTopicID}),
	}}
	conn := &KafkaConnector{consume: fake}

	_, err := conn.consumeWindows(
		context.Background(),
		topic,
		map[int32]partitionWindow{0: {from: 0, upper: 10}},
		10,
		time.Second,
	)

	if !errors.Is(err, errTopicIncarnationChanged) {
		t.Fatalf("consumeWindows error = %v, want it to match errTopicIncarnationChanged", err)
	}
	// The kerr cause must still be reachable for logging/diagnosis.
	if !errors.Is(err, kerr.UnknownTopicID) {
		t.Fatalf("consumeWindows error = %v, want the kerr.UnknownTopicID cause preserved", err)
	}
}

// One purge + exactly one retry. The retry must drop the incoming cursor: those
// offsets belong to the PREVIOUS incarnation of the topic and mean nothing in the
// new one.
func TestConsumeWithIncarnationRetryPurgesAndDropsCursor(t *testing.T) {
	t.Parallel()

	const topic = "orders"
	fake := &fakeConsumer{}
	conn := &KafkaConnector{consume: fake}

	var cursors []map[int32]int64
	attempts := 0
	attempt := func(cursor map[int32]int64) (*consumeResult, map[int32]partitionWindow, error) {
		attempts++
		cursors = append(cursors, cursor)
		if attempts == 1 {
			return nil, nil, fmt.Errorf("%w: stale id", errTopicIncarnationChanged)
		}
		return &consumeResult{rows: []map[string]any{{"offset": int64(1)}}}, map[int32]partitionWindow{0: {from: 0, upper: 1}}, nil
	}

	consumed, windows, cursorReset, err := conn.consumeWithIncarnationRetry(topic, map[int32]int64{0: 42}, attempt)
	if err != nil {
		t.Fatalf("consumeWithIncarnationRetry: %v", err)
	}
	if attempts != 2 {
		t.Fatalf("attempts = %d, want exactly 2 (one retry)", attempts)
	}
	if cursors[0] == nil || cursors[0][0] != 42 {
		t.Fatalf("first attempt must use the caller's cursor, got %#v", cursors[0])
	}
	if cursors[1] != nil {
		t.Fatalf("retry must drop the previous incarnation's cursor, got %#v", cursors[1])
	}
	if !cursorReset {
		t.Fatalf("cursorReset must be true so the frontend replaces rows instead of appending")
	}
	if len(consumed.rows) != 1 || windows == nil {
		t.Fatalf("retry result not returned: rows=%#v windows=%#v", consumed, windows)
	}
	fake.mu.Lock()
	purged := append([]string(nil), fake.purgedTopics...)
	fake.mu.Unlock()
	if len(purged) != 1 || purged[0] != topic {
		t.Fatalf("expected exactly one consumer-side purge of %q, got %#v", topic, purged)
	}
}

// A second failure is not retried again — it becomes a typed, actionable error
// rather than a raw 500 carrying a broker message.
func TestConsumeWithIncarnationRetryGivesUpAfterOneRetry(t *testing.T) {
	t.Parallel()

	const topic = "orders"
	fake := &fakeConsumer{}
	conn := &KafkaConnector{consume: fake}

	attempts := 0
	attempt := func(map[int32]int64) (*consumeResult, map[int32]partitionWindow, error) {
		attempts++
		return nil, nil, fmt.Errorf("%w: stale id", errTopicIncarnationChanged)
	}

	_, _, _, err := conn.consumeWithIncarnationRetry(topic, nil, attempt)

	if attempts != 2 {
		t.Fatalf("attempts = %d, want exactly 2 (no unbounded retry loop)", attempts)
	}
	if !errors.Is(err, connector.ErrUnavailable) {
		t.Fatalf("error = %v, want connector.ErrUnavailable", err)
	}
	if !strings.Contains(err.Error(), topic) {
		t.Fatalf("error %q must name the topic so the message is actionable", err.Error())
	}
}

// A normal failure must not trigger a purge or a retry.
func TestConsumeWithIncarnationRetryLeavesOtherErrorsAlone(t *testing.T) {
	t.Parallel()

	fake := &fakeConsumer{}
	conn := &KafkaConnector{consume: fake}

	attempts := 0
	want := errors.New("broker exploded")
	attempt := func(map[int32]int64) (*consumeResult, map[int32]partitionWindow, error) {
		attempts++
		return nil, nil, want
	}

	_, _, cursorReset, err := conn.consumeWithIncarnationRetry("orders", nil, attempt)

	if attempts != 1 || !errors.Is(err, want) || cursorReset {
		t.Fatalf("attempts=%d err=%v cursorReset=%v, want a single attempt returning the original error", attempts, err, cursorReset)
	}
	fake.mu.Lock()
	purged := len(fake.purgedTopics)
	fake.mu.Unlock()
	if purged != 0 {
		t.Fatalf("no purge may happen for an unrelated error, got %d", purged)
	}
}

// With KeepRetryableFetchErrors the client stops stripping retryable fetch errors,
// so the reader must ignore them itself and keep polling — franz-go still retries
// them internally (metadata moves, a briefly unhealthy broker). Only
// UnknownTopicID is acted on. This is the pattern KeepRetryableFetchErrors' own
// documentation prescribes: "watch for ... UNKNOWN_TOPIC_ID errors being returned
// in fetches (and ignore the other errors)".
func TestConsumeWindowsIgnoresOtherRetryableFetchErrors(t *testing.T) {
	t.Parallel()

	const topic = "orders"
	fake := &fakeConsumer{rounds: []kgo.Fetches{
		fetchRound(topic, partitionFetch{partition: 0, err: kerr.NotLeaderForPartition}),
		fetchRound(topic, partitionFetch{partition: 0, highWatermark: 10, records: []*kgo.Record{
			fetchRecord(topic, 0, 8, `{"n":8}`),
			fetchRecord(topic, 0, 9, `{"n":9}`),
		}}),
	}}
	conn := &KafkaConnector{consume: fake}

	result, err := conn.consumeWindows(
		context.Background(),
		topic,
		map[int32]partitionWindow{0: {from: 8, upper: 10}},
		10,
		2*time.Second,
	)
	if err != nil {
		t.Fatalf("a retryable fetch error must not fail the read: %v", err)
	}
	if len(result.rows) != 2 {
		t.Fatalf("rows = %d, want the 2 records from the round after the retryable error", len(result.rows))
	}
}

// A genuinely fatal fetch error still fails the read rather than being polled over.
func TestConsumeWindowsStillFailsOnNonRetryableFetchError(t *testing.T) {
	t.Parallel()

	const topic = "orders"
	fake := &fakeConsumer{rounds: []kgo.Fetches{
		fetchRound(topic, partitionFetch{partition: 0, err: kerr.TopicAuthorizationFailed}),
	}}
	conn := &KafkaConnector{consume: fake}

	_, err := conn.consumeWindows(context.Background(), topic, map[int32]partitionWindow{0: {from: 0, upper: 10}}, 10, time.Second)
	if !errors.Is(err, connector.ErrForbidden) {
		t.Fatalf("error = %v, want connector.ErrForbidden", err)
	}
}

// ---------------------------------------------------------------------------
// Oldest-first direction.
//
// The cursor contract is the part worth guarding: paging towards newer records
// mirrors every bound, and a mistake here reproduces the silent-skip bug the
// newest-first path already carries scar tissue for. These cases are the mirror
// images of the newest-first ones above.
// ---------------------------------------------------------------------------

// Paging towards newer records, an unproductive partition must fall back to the
// window's LOWER bound (where this request started), and a partition that
// returned rows must advance to one past its highest row — the cursor is an
// inclusive lower bound, so the next page has to start after the last row shown
// or that row appears twice.
func TestComputeFrontierOldestAdvancesPastTheHighestReturnedRow(t *testing.T) {
	t.Parallel()

	frontierWindows := map[int32]partitionWindow{
		0: {from: 10, upper: 100}, // returns rows
		1: {from: 20, upper: 50},  // completed, held no record at all
		2: {from: 30, upper: 60},  // never completed
	}
	rows := []map[string]any{
		{"partition": int32(0), "offset": int64(12)},
		{"partition": int32(0), "offset": int64(17)},
	}
	completed := map[int32]bool{0: true, 1: true}
	completedWindow := map[int32]partitionWindow{
		0: {from: 10, upper: 40},
		1: {from: 20, upper: 50},
	}
	recordsRead := map[int32]bool{0: true}

	frontier := computeFrontier(frontierWindows, rows, false, directionOldest, completed, completedWindow, recordsRead)

	if frontier[0] != 18 {
		t.Errorf("partition 0 must advance to one past its highest returned row (17+1), got %d", frontier[0])
	}
	if frontier[1] != 50 {
		t.Errorf("partition 1 completed with no records — it must advance to its window's upper bound 50, got %d", frontier[1])
	}
	if frontier[2] != 30 {
		t.Errorf("partition 2 never completed — it must stay at the lower bound it started from (30), got %d", frontier[2])
	}
}

// The silent-skip guard, mirrored. A window that completed and DID hold records,
// none of which survived the page trim, must not let the cursor jump past them:
// paging newer, that would move the lower bound ABOVE records the caller never
// saw, making them unreachable for good.
func TestComputeFrontierOldestRefusesToSkipReadButUnreturnedRecords(t *testing.T) {
	t.Parallel()

	frontierWindows := map[int32]partitionWindow{0: {from: 10, upper: 100}}
	completedWindow := map[int32]partitionWindow{0: {from: 10, upper: 40}}

	frontier := computeFrontier(
		frontierWindows,
		nil, // nothing from this partition survived page selection
		false,
		directionOldest,
		map[int32]bool{0: true},
		completedWindow,
		map[int32]bool{0: true}, // but records WERE read
	)

	if frontier[0] != 10 {
		t.Fatalf("the cursor must stay at 10 so the next page re-reads the withheld records, got %d "+
			"(advancing to 40 would skip every record in [10,40) the caller never saw)", frontier[0])
	}
}

// has_newer is the mirror of has_older: a partition is exhausted when its
// frontier reaches the partition END, and a partition drained in this direction
// pins at the end rather than the start.
func TestBuildPaginationCursorOldestDerivesHasNewerAndPinsAtEnd(t *testing.T) {
	t.Parallel()

	bounds := func(int32) (int64, int64) { return 0, 100 }

	t.Run("more to read while a partition is below the end", func(t *testing.T) {
		t.Parallel()
		cursor, hasMore := buildPaginationCursor([]int32{0, 1}, map[int32]int64{0: 40, 1: 100}, nil, directionOldest, bounds)
		if !hasMore {
			t.Errorf("has_newer must be true while partition 0's frontier (40) is below the end (100)")
		}
		if cursor["1"] != 100 {
			t.Errorf("a partition read up to the end must be retained at 100, got %d", cursor["1"])
		}
	})

	t.Run("exhausted once every partition reaches the end", func(t *testing.T) {
		t.Parallel()
		_, hasMore := buildPaginationCursor([]int32{0, 1}, map[int32]int64{0: 100, 1: 100}, nil, directionOldest, bounds)
		if hasMore {
			t.Errorf("has_newer must be false once every partition has been read to its end offset")
		}
	})

	t.Run("already drained partition is carried forward pinned at the end", func(t *testing.T) {
		t.Parallel()
		// Partition 1 drained on an earlier page: absent from frontier, present in
		// the incoming cursor. Pinned at END here, the mirror of start.
		cursor, _ := buildPaginationCursor(
			[]int32{0, 1}, map[int32]int64{0: 40}, map[int32]int64{0: 30, 1: 100}, directionOldest, bounds,
		)
		if got, ok := cursor["1"]; !ok || got != 100 {
			t.Fatalf("drained partition 1 must be carried forward pinned at the end offset 100, got %d (present=%v)", got, ok)
		}
	})
}

// The page must be taken from the OLDEST end, and each partition must still
// contribute a contiguous prefix — that contiguity is what makes the extreme
// selected offset a lossless cursor.
func TestSelectDirectionalPrefixesOldestTakesTheOldestRows(t *testing.T) {
	t.Parallel()

	row := func(partition int32, offset int64, ts string) map[string]any {
		return map[string]any{"partition": partition, "offset": offset, "timestamp": ts}
	}
	rows := []map[string]any{
		row(0, 5, "2026-07-27T10:00:05Z"),
		row(0, 6, "2026-07-27T10:00:06Z"),
		row(1, 90, "2026-07-27T10:00:01Z"),
		row(1, 91, "2026-07-27T10:00:02Z"),
	}

	selected := selectDirectionalPrefixes(rows, 2, directionOldest)

	if len(selected) != 2 {
		t.Fatalf("expected a 2-row page, got %d", len(selected))
	}
	// The two oldest by timestamp are partition 1's, and they must arrive in
	// ascending order.
	for i, want := range []int64{90, 91} {
		if got := rowOffset(t, selected[i]); got != want {
			t.Errorf("row %d: got offset %d, want %d (oldest first)", i, got, want)
		}
	}
}

// Each direction reads only its own cursor field. A client that switches
// direction while still sending the other field must get a fresh read from the
// new direction's end, never a window built from a bound that means the
// opposite thing.
func TestParseCursorOffsetsIsScopedToItsDirection(t *testing.T) {
	t.Parallel()

	before := connector.FilterExpr{Column: "before_offsets", Op: "eq", Value: `{"0":120}`}
	after := connector.FilterExpr{Column: "after_offsets", Op: "eq", Value: `{"0":7}`}

	tests := []struct {
		name      string
		filters   []connector.FilterExpr
		direction readDirection
		want      map[int32]int64
	}{
		{name: "newest reads before_offsets", filters: []connector.FilterExpr{before}, direction: directionNewest, want: map[int32]int64{0: 120}},
		{name: "oldest reads after_offsets", filters: []connector.FilterExpr{after}, direction: directionOldest, want: map[int32]int64{0: 7}},
		{name: "newest ignores an after cursor", filters: []connector.FilterExpr{after}, direction: directionNewest, want: nil},
		{name: "oldest ignores a before cursor", filters: []connector.FilterExpr{before}, direction: directionOldest, want: nil},
		{name: "both present, each takes its own", filters: []connector.FilterExpr{before, after}, direction: directionOldest, want: map[int32]int64{0: 7}},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			got, err := parseCursorOffsets(tc.filters, tc.direction)
			if err != nil {
				t.Fatalf("parseCursorOffsets: %v", err)
			}
			if len(got) != len(tc.want) {
				t.Fatalf("got %v, want %v", got, tc.want)
			}
			for id, want := range tc.want {
				if got[id] != want {
					t.Errorf("partition %d: got %d, want %d", id, got[id], want)
				}
			}
		})
	}
}

// An offset seek names the first message to SHOW in both directions, but the
// bound it becomes is opposite: an exclusive ceiling one past it when paging
// older, the inclusive floor itself when paging newer.
func TestResolveSeekBoundsOffsetIsInclusiveInBothDirections(t *testing.T) {
	t.Parallel()

	conn := &KafkaConnector{}
	seek := seekRequest{offset: 500, hasOffset: true}

	newest, err := conn.resolveSeekBounds(context.Background(), "orders", seek, directionNewest, []int32{3})
	if err != nil {
		t.Fatalf("newest: %v", err)
	}
	if newest[3] != 501 {
		t.Errorf("paging older, the bound is an exclusive ceiling one past the seeked offset: got %d, want 501", newest[3])
	}

	oldest, err := conn.resolveSeekBounds(context.Background(), "orders", seek, directionOldest, []int32{3})
	if err != nil {
		t.Fatalf("oldest: %v", err)
	}
	if oldest[3] != 500 {
		t.Errorf("paging newer, the bound is the inclusive floor itself: got %d, want 500", oldest[3])
	}
}

// snapshotRead must anchor at the partition START when paging towards newer
// records, and its adaptive widening must grow upward.
func TestSnapshotReadOldestAnchorsAtPartitionStart(t *testing.T) {
	t.Parallel()

	const topic = "orders"
	fake := &fakeConsumer{rounds: []kgo.Fetches{
		fetchRound(topic, partitionFetch{partition: 0, highWatermark: 100, records: []*kgo.Record{
			fetchRecord(topic, 0, 10, `{"n":10}`),
			fetchRecord(topic, 0, 11, `{"n":11}`),
		}}),
	}}
	conn := &KafkaConnector{consume: fake}

	starts := kadm.ListedOffsets{topic: {0: {Topic: topic, Partition: 0, Offset: 10}}}
	ends := kadm.ListedOffsets{topic: {0: {Topic: topic, Partition: 0, Offset: 100}}}

	_, frontierWindows, err := conn.snapshotRead(
		context.Background(), topic, []int32{0}, starts, ends, directionOldest, nil, nil, 2,
	)
	if err != nil {
		t.Fatalf("snapshotRead: %v", err)
	}

	window, ok := frontierWindows[0]
	if !ok {
		t.Fatal("partition 0 must have a window")
	}
	if window.from != 10 {
		t.Errorf("paging newer must anchor at the partition start 10, got %d", window.from)
	}
	if window.upper != 100 {
		t.Errorf("the frontier window's ceiling is the partition end 100, got %d", window.upper)
	}

	// The first round must read UP from the start, not down from the end.
	added := fake.added[0][topic]
	if got := added[0].EpochOffset().Offset; got != 10 {
		t.Errorf("the first round must consume from the start offset 10, got %d", got)
	}
}

// Regression: paging towards newer records, each adaptive widening round must
// TILE onto the range the previous round covered, not restart from the same
// edge. Moving the wrong edge makes round 2 re-read round 1's range, and the
// duplicated candidates survive into the page — a live 30-message topic returned
// n = [1,1,2,2,3] instead of [1,2,3,4,5].
//
// Two scoped partitions keep the per-partition quota (3) below the page limit
// (5), which is what forces a second widening round; with a single partition the
// quota IS the page and one round always suffices.
func TestSnapshotReadOldestWidensWithoutRereadingEarlierRounds(t *testing.T) {
	t.Parallel()

	const topic = "orders"
	record := func(offset int64) *kgo.Record {
		return fetchRecord(topic, 0, offset, `{"n":1}`)
	}
	fake := &fakeConsumer{rounds: []kgo.Fetches{
		// Round 1 covers [0,3).
		fetchRound(topic, partitionFetch{partition: 0, highWatermark: 30, records: []*kgo.Record{
			record(0), record(1), record(2),
		}}),
		// Round 2 must continue at 3, never back at 0.
		fetchRound(topic, partitionFetch{partition: 0, highWatermark: 30, records: []*kgo.Record{
			record(3), record(4), record(5),
		}}),
	}}
	conn := &KafkaConnector{consume: fake}

	starts := kadm.ListedOffsets{topic: {
		0: {Topic: topic, Partition: 0, Offset: 0},
		1: {Topic: topic, Partition: 1, Offset: 0},
	}}
	ends := kadm.ListedOffsets{topic: {
		0: {Topic: topic, Partition: 0, Offset: 30},
		1: {Topic: topic, Partition: 1, Offset: 0}, // empty: never gets a window
	}}

	res, _, err := conn.snapshotRead(
		context.Background(), topic, []int32{0, 1}, starts, ends, directionOldest, nil, nil, 5,
	)
	if err != nil {
		t.Fatalf("snapshotRead: %v", err)
	}

	seen := make(map[int64]int, len(res.rows))
	for _, row := range res.rows {
		seen[rowOffset(t, row)]++
	}
	for offset, count := range seen {
		if count > 1 {
			t.Errorf("offset %d appears %d times — a widening round re-read an earlier round's range", offset, count)
		}
	}

	if len(fake.added) < 2 {
		t.Fatalf("expected two widening rounds, got %d", len(fake.added))
	}
	if got := fake.added[1][topic][0].EpochOffset().Offset; got != 3 {
		t.Errorf("round 2 must resume at offset 3 (one past round 1's window), got %d", got)
	}
}

// An offset seek applies to every scoped partition, and one number means a
// different position in each. Partitions whose range does not contain it must
// resolve without inventing anything: a bound past the FAR end covers the whole
// partition, a bound past the NEAR end leaves nothing and the partition is
// skipped entirely. Kafka UI instead clamps to the nearest edge, which presents
// that partition's edge as though it answered the query.
func TestSnapshotReadOffsetSeekAcrossPartitionsSkipsOutOfRange(t *testing.T) {
	t.Parallel()

	const topic = "orders"
	// Three partitions whose ranges have drifted apart, as on a long-lived topic.
	starts := kadm.ListedOffsets{topic: {
		0: {Topic: topic, Partition: 0, Offset: 1000},
		1: {Topic: topic, Partition: 1, Offset: 5000},
		2: {Topic: topic, Partition: 2, Offset: 100},
	}}
	ends := kadm.ListedOffsets{topic: {
		0: {Topic: topic, Partition: 0, Offset: 2000}, // contains 1500
		1: {Topic: topic, Partition: 1, Offset: 6000}, // entirely ABOVE 1500
		2: {Topic: topic, Partition: 2, Offset: 500},  // entirely BELOW 1500
	}}
	scoped := []int32{0, 1, 2}

	// A high watermark above every window with no records completes each windowed
	// partition immediately (reachedEmptyEnd), so the read terminates on its own
	// and the assertion is about which windows were BUILT, not about timing.
	emptyButComplete := func() *fakeConsumer {
		return &fakeConsumer{rounds: []kgo.Fetches{
			fetchRound(topic,
				partitionFetch{partition: 0, highWatermark: 1_000_000},
				partitionFetch{partition: 1, highWatermark: 1_000_000},
				partitionFetch{partition: 2, highWatermark: 1_000_000},
			),
		}}
	}

	tests := []struct {
		name      string
		direction readDirection
		seekBound int64 // what resolveSeekBounds produces for offset 1500
		want      map[int32]partitionWindow
	}{
		{
			// "everything at or below 1500": p0 is bounded mid-range, p1 has
			// nothing that low, p2 is entirely below it so all of it qualifies.
			name:      "newest",
			direction: directionNewest,
			seekBound: 1501,
			want: map[int32]partitionWindow{
				0: {from: 1000, upper: 1501},
				2: {from: 100, upper: 500},
			},
		},
		{
			// "everything at or above 1500": p0 is bounded from 1500 up, p1 is
			// entirely above it so all of it qualifies, p2 has nothing that high.
			name:      "oldest",
			direction: directionOldest,
			seekBound: 1500,
			want: map[int32]partitionWindow{
				0: {from: 1500, upper: 2000},
				1: {from: 5000, upper: 6000},
			},
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			bounds := map[int32]int64{}
			for _, id := range scoped {
				bounds[id] = tc.seekBound
			}

			conn := &KafkaConnector{consume: emptyButComplete()}
			_, frontierWindows, err := conn.snapshotRead(
				context.Background(), topic, scoped, starts, ends, tc.direction, bounds, nil, 10,
			)
			if err != nil {
				t.Fatalf("snapshotRead: %v", err)
			}

			if len(frontierWindows) != len(tc.want) {
				t.Fatalf("windowed partitions = %v, want %v", frontierWindows, tc.want)
			}
			for id, want := range tc.want {
				got, ok := frontierWindows[id]
				if !ok {
					t.Errorf("partition %d must have a window %v", id, want)
					continue
				}
				if got != want {
					t.Errorf("partition %d window = %v, want %v", id, got, want)
				}
			}
		})
	}
}

// resolveSeekBounds must place an offset bound on EVERY scoped partition, not
// just one, and keep the direction's inclusive semantics for each.
func TestResolveSeekBoundsOffsetCoversEveryScopedPartition(t *testing.T) {
	t.Parallel()

	conn := &KafkaConnector{}
	scoped := []int32{0, 3, 7}
	seek := seekRequest{offset: 500, hasOffset: true}

	newest, err := conn.resolveSeekBounds(context.Background(), "orders", seek, directionNewest, scoped)
	if err != nil {
		t.Fatalf("newest: %v", err)
	}
	oldest, err := conn.resolveSeekBounds(context.Background(), "orders", seek, directionOldest, scoped)
	if err != nil {
		t.Fatalf("oldest: %v", err)
	}

	for _, id := range scoped {
		if newest[id] != 501 {
			t.Errorf("newest bound for partition %d = %d, want 501", id, newest[id])
		}
		if oldest[id] != 500 {
			t.Errorf("oldest bound for partition %d = %d, want 500", id, oldest[id])
		}
	}
	if len(newest) != len(scoped) || len(oldest) != len(scoped) {
		t.Errorf("bounds must cover exactly the scoped partitions, got %v / %v", newest, oldest)
	}
}
