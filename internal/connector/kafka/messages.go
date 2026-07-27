package kafka

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/twmb/franz-go/pkg/kadm"
	"github.com/twmb/franz-go/pkg/kerr"
	"github.com/twmb/franz-go/pkg/kgo"
	"github.com/zxchlorka/kizuna/internal/connector"
	"golang.org/x/sync/errgroup"
)

const (
	defaultMessageLimit = 50
	maxMessageLimit     = 500

	// readBudget bounds one fast-snapshot refresh across all of its adaptive
	// rounds. A normal browse returns a recent snapshot quickly and, if some
	// partitions are slow, returns the safely completed ones as a partial page
	// instead of failing the whole request.
	//
	// This is a safety net for a genuinely slow cluster, not the mechanism that
	// keeps a browse fast — that is fetchMaxPartitionBytes in kafka.go. While the
	// reader still used franz-go's 1 MiB default a wide topic pulled ~100 MB per
	// page and this budget cut it off with less than half the partitions finished,
	// which the UI then reported as a handful of messages. With the fetch sized to
	// the window a full round moves a couple of MB, so the budget is a ceiling
	// again rather than the normal case. It is deliberately NOT generous:
	// completionGrace, not this value, decides how long a full page waits on a
	// straggler.
	readBudget = 3 * time.Second

	// completionGrace bounds how long the poll loop keeps waiting for outstanding
	// partitions AFTER the page target is already met. Without it a single slow
	// partition out of dozens held the whole request until readBudget expired even
	// though the answer was complete — measured on a 54-partition topic, a page
	// that needed ~180 records took the entire budget because 2 partitions lagged.
	// Sized to comfortably cover one more fetch round trip on a healthy cluster,
	// so full coverage is still the normal outcome and only genuine stragglers get
	// dropped from the page's partition set.
	completionGrace = 400 * time.Millisecond
	// maxAdaptiveRounds caps how many times snapshotRead widens partition windows
	// to backfill a short page, guaranteeing the refill terminates.
	maxAdaptiveRounds = 5
	// maxCandidateOffsets caps the total offsets scanned across every round of a
	// single refresh, bounding candidate memory even with large payloads.
	maxCandidateOffsets = 4000

	// Content-search scan budget for one "Scan more" step. A single step
	// examines at most maxScanMessages records (across scoped partitions) within
	// scanTimeBudget, then returns matches plus a cursor to continue deeper. This
	// budget is intentionally separate from the normal-browse readBudget so
	// reader tuning never changes the scan budget.
	maxScanMessages = 5000
	scanTimeBudget  = 8 * time.Second
)

// Raw candidate fields hold copied record bytes captured during the poll loop.
// Deserialization is deferred until final page selection; finalizeRow strips
// these keys from the returned display row.
const (
	rawKeyField   = "_raw_key"
	rawValueField = "_raw_value"
)

// errReadBudgetExhausted is the specific failure consumeWindows returns when its
// read budget expires before a single scoped partition finished — no usable data
// at all. It wraps connector.ErrTimeout so the normal-browse path (and its unit
// test) still see a plain timeout, but it is a distinct sentinel value so the
// content-search path can recognise this one case and degrade it gracefully via
// resolveScanConsume, without mistaking a genuine broker timeout (which also maps
// to ErrTimeout in normalizeKafkaError) for it.
var errReadBudgetExhausted = fmt.Errorf(
	"%w: kafka read budget expired before any partition produced a usable result",
	connector.ErrTimeout,
)

type partitionWindow struct {
	from  int64
	upper int64 // exclusive
}

// partitionConsumer is the subset of *kgo.Client that consumeWindows drives.
// Keeping it an interface lets unit tests inject a deterministic fake broker so
// partial-result, budget-timeout and cancellation behavior can be verified
// without a live cluster. *kgo.Client satisfies this structurally.
type partitionConsumer interface {
	AddConsumePartitions(map[string]map[int32]kgo.Offset)
	RemoveConsumePartitions(map[string][]int32)
	PauseFetchPartitions(map[string][]int32) map[string][]int32
	ResumeFetchPartitions(map[string][]int32)
	PollFetches(context.Context) kgo.Fetches
	// PurgeTopicsFromConsuming drops the client's cached name -> topic-UUID
	// mapping for a topic. Deliberately the consuming-only purge: the full
	// PurgeTopicsFromClient also clears producer state, which can cause
	// out-of-order sequence errors on the next Produce. The consumer-side purge
	// touches nothing the producer owns, so one shared client stays safe.
	PurgeTopicsFromConsuming(...string)
}

// errTopicIncarnationChanged marks the stale-topic-ID failure that follows a
// delete/recreate of a topic under the same name. Kafka addresses topics by UUID
// in fetch requests (KIP-516) and the long-lived client caches name -> UUID, so
// the recreated topic's new UUID makes every fetch fail with UnknownTopicID until
// the mapping is purged. It is a distinct sentinel because normalizeKafkaError
// folds the *kerr.Error into a message string, which would make the condition
// undetectable further up.
var errTopicIncarnationChanged = errors.New("kafka topic incarnation changed")

type consumeResult struct {
	rows      []map[string]any
	completed map[int32]bool
	timedOut  bool
	// partial reports that the read budget was exhausted before every scoped
	// partition finished, yet at least one partition completed with safe rows
	// that are returned to the caller. Task 2's fast snapshot reader sets this;
	// Task 3 surfaces it as DataResult.Meta["partial"].
	partial bool
	// candidatesRead counts every raw record read off the broker for a scoped
	// partition during this call, including records later discarded because
	// their partition never completed within budget. It is strictly an
	// observability counter (DataResult.Meta["candidates_read"]) and never
	// drives a control-flow decision, so approximate double counting across
	// edge cases (e.g. a record delivered just as its partition pauses) is
	// harmless.
	candidatesRead int
	// completedFrom records, for each partition that completed in THIS call,
	// the window's lower bound (offset) it was confirmed read down to — even
	// when that window produced zero rows. lowestConsumedOffsets (used for the
	// pagination cursor) only ever sees actual rows, so without this a
	// partition that completes with zero rows in its window would never
	// advance its cursor and would be rescanned forever. Populated at the same
	// place completed[id] is set, so it is only ever set for genuinely
	// completed partitions.
	completedFrom map[int32]int64
	// pageSatisfied reports that the poll loop returned early, on purpose, because
	// the page target was already met and the remaining partitions did not land
	// within completionGrace. It is deliberately distinct from timedOut/partial:
	// the response is a full page, so it must not be reported as degraded. Only
	// the coverage figure (partitions_completed) is lower than it would be had the
	// loop waited out the whole budget.
	pageSatisfied bool
	// recordsRead marks, for each partition that completed in THIS call, whether
	// its completed window actually contained at least one record inside
	// [window.from, window.upper). It is the guard that separates the two cases
	// completedFrom alone cannot tell apart:
	//
	//   - completed window with ZERO records (empty / fully-compacted range):
	//     advancing the cursor to completedFrom is safe and necessary (Task 3's
	//     stuck-cursor fix — nothing is lost).
	//   - completed window that DID contain records, none of which survived final
	//     page selection: advancing to completedFrom would move the cursor past
	//     records that were read from the broker but never returned to the
	//     caller, making them permanently unreachable (silent data loss).
	//
	// Set at the same place completed[id]/completedFrom[id] are, so it is keyed
	// only by genuinely completed partitions and always describes the same window
	// completedFrom describes. See computeFrontier for how it is consumed.
	recordsRead map[int32]bool
}

// GetData reads one page of messages, newest first. Filters:
//   - partition: restrict to one partition (default: all)
//   - before_offsets: JSON map partition->offset from the previous page's
//     meta.next_before_offsets; fetches the window right below it.
func (c *KafkaConnector) GetData(ctx context.Context, topic string, opts connector.DataOpts) (*connector.DataResult, error) {
	callStart := time.Now()

	limit := opts.Limit
	if limit <= 0 {
		limit = defaultMessageLimit
	}
	if limit > maxMessageLimit {
		limit = maxMessageLimit
	}

	partitionFilter, err := parsePartitionFilter(opts.Filters)
	if err != nil {
		return nil, err
	}
	beforeOffsets, err := parseBeforeOffsets(opts.Filters)
	if err != nil {
		return nil, err
	}
	matchField, matchValue := parseMatchFilter(opts.Filters)
	scanning := matchField != ""
	seek, err := parseSeek(opts.Filters, partitionFilter)
	if err != nil {
		return nil, err
	}

	metaCtx, cancelMeta := context.WithTimeout(ctx, metadataTimeout)
	defer cancelMeta()

	metadataStart := time.Now()
	var starts, ends kadm.ListedOffsets
	group, groupCtx := errgroup.WithContext(metaCtx)
	group.Go(func() error {
		listed, err := c.admin.ListStartOffsets(groupCtx, topic)
		if err == nil {
			starts = listed
		}
		return err
	})
	group.Go(func() error {
		listed, err := c.admin.ListEndOffsets(groupCtx, topic)
		if err == nil {
			ends = listed
		}
		return err
	})
	if err := group.Wait(); err != nil {
		return nil, normalizeKafkaError(err)
	}
	metadataMs := time.Since(metadataStart).Milliseconds()
	endsByPartition, ok := ends[topic]
	if !ok || len(endsByPartition) == 0 || partitionsAllErrored(endsByPartition) {
		return nil, fmt.Errorf("%w: topic %q not found", connector.ErrRelationNotFound, topic)
	}

	partitionIDs := sortedPartitionIDs(endsByPartition)
	var total int64
	scoped := make([]int32, 0, len(partitionIDs))
	for _, id := range partitionIDs {
		start, end := partitionOffsets(topic, id, starts, ends)
		total += maxInt64(0, end-start)
		if partitionFilter >= 0 && id != partitionFilter {
			continue
		}
		scoped = append(scoped, id)
	}
	if partitionFilter >= 0 && len(scoped) == 0 {
		return nil, fmt.Errorf("%w: partition %d not found in topic %q", connector.ErrBadRequest, partitionFilter, topic)
	}

	// Resolved once per request, then folded into each partition's window bound
	// alongside the pagination cursor: the seek fixes where paging starts, the
	// cursor tracks how far down it has walked, and the tighter of the two wins.
	seekCeilings, err := c.resolveSeekCeilings(ctx, topic, seek, partitionFilter)
	if err != nil {
		return nil, err
	}

	var (
		consumed        *consumeResult
		frontierWindows map[int32]partitionWindow
	)
	consumeStart := time.Now()
	// One attempt at reading, parameterised by the pagination cursor so the
	// topic-recreation retry can re-run it with a cleared cursor.
	readAttempt := func(cursor map[int32]int64) (*consumeResult, map[int32]partitionWindow, error) {
		if scanning {
			// Content search reads a larger, evenly divided window per partition under
			// its own scan budget. This path is deliberately separate from the normal
			// browse quota so reader tuning never changes the scan budget.
			perPartition := dividedWindow(maxScanMessages, len(scoped))
			windows := make(map[int32]partitionWindow, len(scoped))
			for _, id := range scoped {
				start, end := partitionOffsets(topic, id, starts, ends)
				upper := end
				if ceiling, ok := seekCeilings[id]; ok && ceiling < upper {
					upper = ceiling
				}
				if before, ok := cursor[id]; ok && before < upper {
					upper = before
				}
				if upper <= start {
					continue
				}
				from := upper - perPartition
				if from < start {
					from = start
				}
				windows[id] = partitionWindow{from: from, upper: upper}
			}
			result, scanErr := resolveScanConsume(c.consumeWindows(ctx, topic, windows, maxScanMessages, scanTimeBudget))
			if scanErr != nil {
				return nil, nil, scanErr
			}
			return result, windows, nil
		}
		// Normal browse: bounded-quota fast snapshot with adaptive refill.
		return c.snapshotRead(ctx, topic, scoped, starts, ends, seekCeilings, cursor, limit)
	}

	consumed, frontierWindows, cursorReset, err := c.consumeWithIncarnationRetry(topic, beforeOffsets, readAttempt)
	if err != nil {
		return nil, err
	}
	if cursorReset {
		// The retry read the recreated topic from its newest end, so this page is a
		// fresh start; the caller must replace rows rather than append to a page
		// built from the previous incarnation.
		beforeOffsets = nil
	}
	consumeMs := time.Since(consumeStart).Milliseconds()

	rows := consumed.rows
	if !scanning {
		rows = selectNewestPrefixes(rows, limit)
	}

	sortRowsNewest(rows)

	// Advance only partitions whose rows are actually returned to the caller (or
	// whose window is confirmed to hold no record at all). Unread partitions, and
	// partitions whose records were read but trimmed out of this page, keep their
	// prior upper offset, so neither partial broker replies nor page selection
	// can create pagination gaps.
	frontier := computeFrontier(frontierWindows, rows, scanning, consumed.completed, consumed.completedFrom, consumed.recordsRead)

	nextBefore, hasOlder := buildPaginationCursor(scoped, frontier, beforeOffsets, func(id int32) int64 {
		start, _ := partitionOffsets(topic, id, starts, ends)
		return start
	})

	// partitions_total counts only the SCOPED partitions matching the current
	// filter (1 when a single partition is selected) — a semantic correction
	// from the pre-Task-3 "partitions" key, which counted every partition of
	// the topic regardless of filtering. Nothing on the frontend currently
	// reads meta.partitions from this endpoint (frontend/src/stores/kafka.ts's
	// MessagesResponse.meta type declares it but never consumes it, and the two
	// unrelated call sites in ObjectTree.tsx / KafkaConsumerGroups.tsx read
	// meta.partitions from the topic-listing and consumer-group endpoints, not
	// this one), so this is a plain rename rather than an additive field.
	meta := map[string]any{
		"partitions_total":     len(scoped),
		"partitions_completed": len(consumed.completed),
		"has_older":            hasOlder,
		"candidates_read":      consumed.candidatesRead,
	}
	if cursorReset {
		// The topic was recreated mid-session: this page starts a new incarnation,
		// so the caller must replace whatever it already holds instead of appending.
		meta["cursor_reset"] = true
	}
	if scanning {
		meta["scanning"] = true
		meta["scanned"] = len(rows)
		if consumed.timedOut {
			meta["partial_scan"] = true
		}
		// Content search must inspect every candidate, so it deserializes them all
		// before testing the match predicate.
		rows = filterMatches(finalizeRows(rows), matchField, matchValue)
		meta["matched"] = len(rows)
	} else {
		// Deferred deserialization: only the rows that survived page selection are
		// deserialized for display.
		rows = finalizeRows(rows)
		meta["partial"] = consumed.partial
		if consumed.partial {
			meta["partial_reason"] = "read_budget_exhausted"
		}
		meta["messages_returned"] = len(rows)
	}
	// Emit the cursor only when there is genuinely more to fetch. next_before_offsets
	// now includes every scoped partition (drained ones pinned at their start), so
	// its size is no longer a "has more" signal; gate on hasOlder instead. This keeps
	// the prior wire invariant the frontend relies on: next_before_offsets is present
	// exactly when has_older is true (kafka.ts's "Scan more"/"Load older" guards).
	if hasOlder {
		meta["next_before_offsets"] = nextBefore
	}

	elapsedMs := time.Since(callStart).Milliseconds()
	meta["elapsed_ms"] = elapsedMs

	// One structured log line per reader request. Only counts/timings/booleans/
	// the topic name are logged — never payload, key, headers, credentials, or
	// broker secrets.
	slog.Debug("kafka message reader request",
		"topic", topic,
		"limit", limit,
		"scanning", scanning,
		"partitions_total", len(scoped),
		"partitions_completed", len(consumed.completed),
		"metadata_ms", metadataMs,
		"consume_ms", consumeMs,
		"elapsed_ms", elapsedMs,
		"candidates", consumed.candidatesRead,
		"returned", len(rows),
		"partial", consumed.partial,
	)

	return &connector.DataResult{
		Columns: []connector.ColumnMeta{
			{Name: "partition", DataType: "integer"},
			{Name: "offset", DataType: "integer"},
			{Name: "timestamp", DataType: "timestamp"},
			{Name: "key", DataType: "text"},
			{Name: "value", DataType: "text"},
			{Name: "format", DataType: "text"},
			{Name: "headers", DataType: "json"},
		},
		Rows:    rows,
		Total:   total,
		HasMore: hasOlder,
		Meta:    meta,
	}, nil
}

// consumeWindows temporarily assigns exact offset windows to the connector's
// long-lived franz-go client. Reusing the client keeps broker metadata and
// TCP/TLS/SASL connections warm; consumeMu protects the client's direct
// assignment state from overlapping message requests.
func (c *KafkaConnector) consumeWindows(
	ctx context.Context,
	topic string,
	windows map[int32]partitionWindow,
	target int,
	timeout time.Duration,
) (*consumeResult, error) {
	result := &consumeResult{
		rows:          make([]map[string]any, 0, target),
		completed:     make(map[int32]bool, len(windows)),
		completedFrom: make(map[int32]int64, len(windows)),
		recordsRead:   make(map[int32]bool, len(windows)),
	}
	if len(windows) == 0 {
		return result, nil
	}

	offsets := make(map[int32]kgo.Offset, len(windows))
	partitionIDs := make([]int32, 0, len(windows))
	for id, window := range windows {
		offsets[id] = kgo.NewOffset().At(window.from)
		partitionIDs = append(partitionIDs, id)
	}

	c.consumeMu.Lock()
	defer c.consumeMu.Unlock()

	c.consume.AddConsumePartitions(map[string]map[int32]kgo.Offset{topic: offsets})
	defer func() {
		c.consume.RemoveConsumePartitions(map[string][]int32{topic: partitionIDs})
		c.consume.ResumeFetchPartitions(map[string][]int32{topic: partitionIDs})
	}()

	consumeCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	rowsByPartition := make(map[int32][]map[string]any, len(windows))
	maxSeen := make(map[int32]int64, len(windows))
	seenPartition := make(map[int32]bool, len(windows))
	reachedEmptyEnd := make(map[int32]bool, len(windows))
	// pollCtx bounds an individual PollFetches. It normally lives as long as
	// consumeCtx; once the page target is met, graceTimer cancels it after
	// completionGrace so a straggling partition cannot hold a finished page for
	// the rest of the read budget. Cancelling via a timer rather than a second
	// derived deadline keeps exactly one cancel func on one unconditional defer.
	pollCtx, cancelPoll := context.WithCancel(consumeCtx)
	defer cancelPoll()
	var graceTimer *time.Timer
	defer func() {
		if graceTimer != nil {
			graceTimer.Stop()
		}
	}()

	for {
		fetches := c.consume.PollFetches(pollCtx)
		if fetches.IsClientClosed() {
			return nil, fmt.Errorf("%w: kafka consumer closed while reading messages", connector.ErrUnavailable)
		}

		var fetchErr error
		for _, fetchError := range fetches.Errors() {
			// Gated on pollCtx, not consumeCtx: once the grace deadline is armed,
			// pollCtx can expire while the read budget still has time left, and the
			// resulting context error is our own deadline rather than a broker
			// failure. Attributing it to the broker would turn a deliberate early
			// return into a spurious hard error.
			if pollCtx.Err() != nil {
				continue
			}
			fetchErr = fetchError.Err
			break
		}
		if fetchErr != nil {
			// UnknownTopicID is checked before normalizeKafkaError on purpose: that
			// helper keeps only the message text, and the caller needs the typed cause
			// to decide whether a purge-and-retry is warranted.
			if errors.Is(fetchErr, kerr.UnknownTopicID) {
				return nil, fmt.Errorf("%w: %w", errTopicIncarnationChanged, fetchErr)
			}
			// The client runs with KeepRetryableFetchErrors so the recreated-topic
			// signal above is not silently stripped. That also surfaces the ordinary
			// retryable errors franz-go used to hide (leader moved, broker briefly
			// unhealthy); it retries them internally, so the reader keeps polling and
			// lets the read budget decide, exactly as before the flag.
			if !kerr.IsRetriable(fetchErr) {
				return nil, normalizeKafkaError(fetchErr)
			}
		}

		fetches.EachRecord(func(record *kgo.Record) {
			window, ok := windows[record.Partition]
			if !ok {
				return
			}
			result.candidatesRead++
			if result.completed[record.Partition] || record.Offset < window.from {
				return
			}
			if record.Offset > maxSeen[record.Partition] {
				maxSeen[record.Partition] = record.Offset
			}
			seenPartition[record.Partition] = true
			if record.Offset < window.upper {
				rowsByPartition[record.Partition] = append(rowsByPartition[record.Partition], rawCandidateRow(record))
			}
		})
		fetches.EachPartition(func(partition kgo.FetchTopicPartition) {
			window, ok := windows[partition.Partition]
			if partition.Topic == topic && ok && len(partition.Records) == 0 && partition.HighWatermark >= window.upper {
				reachedEmptyEnd[partition.Partition] = true
			}
		})

		newlyCompleted := make(map[string][]int32)
		for id, window := range windows {
			if result.completed[id] || (!reachedEmptyEnd[id] && (!seenPartition[id] || maxSeen[id] < window.upper-1)) {
				continue
			}
			result.completed[id] = true
			result.completedFrom[id] = window.from
			if len(rowsByPartition[id]) > 0 {
				// This completed window held real records inside [from, upper).
				// Whether they survive final page selection is decided later, so
				// the cursor must not blind-advance past this window on the
				// strength of completedFrom alone (see computeFrontier).
				result.recordsRead[id] = true
			}
			result.rows = append(result.rows, rowsByPartition[id]...)
			newlyCompleted[topic] = append(newlyCompleted[topic], id)
		}
		if len(newlyCompleted[topic]) > 0 {
			c.consume.PauseFetchPartitions(newlyCompleted)
		}

		if len(result.completed) == len(windows) {
			break
		}
		if consumeCtx.Err() != nil {
			result.timedOut = true
			break
		}
		// The page target is met but some partitions are still outstanding. Arm a
		// short grace deadline rather than holding the request until the full read
		// budget expires: on a healthy cluster the stragglers land in the very next
		// poll and nothing changes, while one slow partition out of dozens no longer
		// costs the user every remaining second of the budget.
		if graceTimer == nil && len(result.rows) >= target {
			graceTimer = time.AfterFunc(completionGrace, cancelPoll)
		}
		// Checked after consumeCtx above, so a genuinely expired read budget is
		// still classified as a timeout rather than as a satisfied page.
		if pollCtx.Err() != nil {
			// Grace expired with a full page in hand. Deliberately not timedOut: the
			// response is complete, so it must not be reported as a degraded read.
			result.pageSatisfied = true
			break
		}
	}

	completedCount := len(result.completed)
	if completedCount == len(windows) {
		// Every scoped partition finished its bounded range within budget.
		return result, nil
	}
	if result.pageSatisfied {
		// Stopped on purpose with the page target already met, so this is a
		// complete answer built from fewer partitions — not a shortfall. The
		// outstanding partitions simply keep their prior upper offset (see
		// computeFrontier), so their records stay reachable on the next page or
		// refresh and nothing is lost.
		return result, nil
	}

	// The read budget (or the caller's context) expired before every partition
	// finished. Distinguish a usable partial page from a total failure.
	result.timedOut = true
	if completedCount == 0 {
		// Not a single partition produced a safely-bounded result: an unresponsive
		// broker or uniformly slow partitions, not an empty success. Surface it as
		// a real error rather than a partial page with no data. The normal-browse
		// path propagates this as a hard timeout; the content-search path recognises
		// this exact sentinel and degrades it to an empty partial scan.
		return nil, errReadBudgetExhausted
	}
	// At least one partition completed with safe rows and at least one did not:
	// return only the completed partitions' rows and flag the page partial.
	result.partial = true
	return result, nil
}

// resolveScanConsume adapts a consumeWindows (result, error) pair for the
// content-search path. The normal-browse path treats "read budget expired before
// any partition finished" as a hard error, but a progressive scan step must not:
// that case previously returned an empty partial scan (HTTP 200, partial_scan=true,
// 0 matches) so the frontend's "Scan more" loop keeps going instead of halting on
// an error banner. This helper restores that tolerance for exactly the
// errReadBudgetExhausted sentinel and nothing else — a genuine broker/auth failure
// (ErrForbidden, ErrUnavailable, a broker RequestTimedOut, unknown topic, …) still
// propagates as an error, so real failures never masquerade as an empty scan.
//
// It is a pure function of its inputs so the scanning branch's error/decision
// handling is unit-testable without GetData's concrete *kadm.Client metadata calls.
func resolveScanConsume(consumed *consumeResult, err error) (*consumeResult, error) {
	if err == nil {
		return consumed, nil
	}
	if errors.Is(err, errReadBudgetExhausted) {
		// Budget expired with nothing completed: degrade to an empty, budget-
		// exhausted result. timedOut drives meta["partial_scan"], scanned/matched
		// become 0, and the cursor is untouched, so the scan loop continues deeper.
		return &consumeResult{
			rows:          make([]map[string]any, 0),
			completed:     make(map[int32]bool),
			completedFrom: make(map[int32]int64),
			recordsRead:   make(map[int32]bool),
			timedOut:      true,
		}, nil
	}
	return nil, err
}

// snapshotRead builds a recent cross-partition snapshot for the normal browse
// path. Every scoped partition starts at a small quota window; if empty or
// compacted partitions leave the page short, snapshotRead widens the still-
// readable partitions over a bounded number of adaptive rounds. It never refills
// forever: it stops as soon as the page target is met, no partition has older
// records left, the round cap is reached, the candidate-offset budget is spent,
// or the read budget expires.
//
// The returned consumeResult carries rows only from safely completed partition
// windows (never in-flight partition data), plus the partial flag and completion
// map that Task 3 surfaces. frontierWindows maps each scoped partition to its
// original upper bound for the pagination cursor.
func (c *KafkaConnector) snapshotRead(
	ctx context.Context,
	topic string,
	scoped []int32,
	starts, ends kadm.ListedOffsets,
	seekCeilings map[int32]int64,
	beforeOffsets map[int32]int64,
	limit int,
) (*consumeResult, map[int32]partitionWindow, error) {
	quota := initialPartitionQuota(limit, len(scoped))

	// start is the partition's low offset; floor is the exclusive lower bound of
	// the next round's window and moves down as we widen.
	start := make(map[int32]int64, len(scoped))
	floor := make(map[int32]int64, len(scoped))
	frontierWindows := make(map[int32]partitionWindow, len(scoped))
	for _, id := range scoped {
		low, end := partitionOffsets(topic, id, starts, ends)
		upper := end
		if ceiling, ok := seekCeilings[id]; ok && ceiling < upper {
			upper = ceiling
		}
		if before, ok := beforeOffsets[id]; ok && before < upper {
			upper = before
		}
		if upper <= low {
			continue
		}
		start[id] = low
		floor[id] = upper
		frontierWindows[id] = partitionWindow{from: low, upper: upper}
	}

	aggregate := &consumeResult{
		rows:          make([]map[string]any, 0, limit),
		completed:     make(map[int32]bool, len(frontierWindows)),
		completedFrom: make(map[int32]int64, len(frontierWindows)),
		recordsRead:   make(map[int32]bool, len(frontierWindows)),
	}
	if len(frontierWindows) == 0 {
		// Every scoped partition is empty at/below the cursor: a clean empty page.
		return aggregate, frontierWindows, nil
	}

	budgetCtx, cancel := context.WithTimeout(ctx, readBudget)
	defer cancel()

	widen := quota
	var scannedOffsets int64
	for round := 0; round < maxAdaptiveRounds; round++ {
		if budgetCtx.Err() != nil {
			break
		}

		windows := make(map[int32]partitionWindow, len(frontierWindows))
		for id := range frontierWindows {
			if floor[id] <= start[id] {
				continue // nothing older left to read in this partition
			}
			from := floor[id] - widen
			if from < start[id] {
				from = start[id]
			}
			windows[id] = partitionWindow{from: from, upper: floor[id]}
			scannedOffsets += floor[id] - from
		}
		if len(windows) == 0 {
			break // every partition has been read down to its start offset
		}

		consumed, err := c.consumeWindows(budgetCtx, topic, windows, limit, readBudget)
		if err != nil {
			if len(aggregate.completed) > 0 {
				// Earlier rounds already produced safe rows; treat the exhausted
				// budget as a partial page instead of discarding that work.
				// consumeWindows only returns an error when ZERO partitions
				// completed this round, so every partition attempted in `windows`
				// failed to finish. Any of them that an earlier round had marked
				// completed must flip back to not-completed for THIS response, so
				// partitions_completed reflects the coverage actually delivered
				// rather than a stale "completed at least one round ever" union
				// (which could otherwise equal partitions_total while partial is
				// true). completedFrom is intentionally left untouched: an earlier
				// round's confirmed lower bound is still a valid cursor floor.
				for id := range windows {
					delete(aggregate.completed, id)
				}
				aggregate.partial = true
				aggregate.timedOut = true
				return aggregate, frontierWindows, nil
			}
			return nil, nil, err
		}

		// Each round is authoritative for the partitions it attempted: overwrite
		// every partition in this round's `windows` with THIS round's status
		// instead of OR-ing completions across rounds. A partition that completed
		// an earlier round but was widened into again and cut short by the budget
		// correctly flips back to not-completed, so partitions_completed can never
		// equal partitions_total while partial is true. A partition that completed
		// and was never re-attempted (page filled, or nothing older left to widen
		// into) is simply not in a later `windows` map and keeps its completed
		// status. completed is a set whose len() is the partitions_completed count,
		// so a not-completed partition is removed rather than stored as false.
		for id := range windows {
			if consumed.completed[id] {
				aggregate.completed[id] = true
				// A later round always reads a strictly lower (or equal) window than
				// an earlier one for the same partition, so overwriting here always
				// keeps the deepest confirmed bound for the cursor fallback.
				aggregate.completedFrom[id] = consumed.completedFrom[id]
				// recordsRead, unlike completed/completedFrom, is STICKY across
				// rounds — it is OR-ed, never overwritten or deleted. completedFrom
				// deepens with every widening round, so a later round that reads a
				// genuinely empty deeper window would otherwise let the cursor
				// leapfrog past records an EARLIER round of the same request read
				// and withheld from the page. Because the rounds tile the range
				// [completedFrom, upper) contiguously downward, the OR over all
				// completed rounds answers exactly "did this request read any record
				// in the range the cursor would advance past".
				if consumed.recordsRead[id] {
					aggregate.recordsRead[id] = true
				}
			} else {
				delete(aggregate.completed, id)
			}
		}
		aggregate.rows = append(aggregate.rows, consumed.rows...)
		aggregate.candidatesRead += consumed.candidatesRead
		for id := range windows {
			floor[id] = windows[id].from
		}
		if consumed.partial {
			aggregate.partial = true
		}
		if consumed.timedOut {
			aggregate.timedOut = true
		}

		switch {
		case consumed.partial || consumed.timedOut:
			return aggregate, frontierWindows, nil // budget spent mid-round
		case len(aggregate.rows) >= limit:
			return aggregate, frontierWindows, nil // enough candidates for a page
		case scannedOffsets >= maxCandidateOffsets:
			return aggregate, frontierWindows, nil // candidate-offset budget spent
		}
		widen *= 2
	}

	return aggregate, frontierWindows, nil
}

func dividedWindow(total, partitions int) int64 {
	if partitions <= 1 {
		return int64(total)
	}
	return int64((total + partitions - 1) / partitions)
}

// The global newest N can contain all N rows from one partition. Reading the
// newest N from every scoped partition is therefore the smallest fixed window
// that can produce an exact cross-partition top N without distribution bias.
func normalPartitionWindow(limit int) int64 {
	return int64(limit)
}

// initialPartitionQuota returns the per-partition read window for a fast
// snapshot page: max(1, ceil(pageSize/scopedPartitionCount)). A 100-message page
// across 54 partitions therefore reads ~2 offsets per partition instead of 100,
// favouring cross-partition coverage over per-partition depth. A single scoped
// partition still reads the whole page.
func initialPartitionQuota(pageSize, scopedPartitionCount int) int64 {
	if scopedPartitionCount <= 1 {
		return int64(pageSize)
	}
	quota := (pageSize + scopedPartitionCount - 1) / scopedPartitionCount
	if quota < 1 {
		quota = 1
	}
	return int64(quota)
}

// selectNewestPrefixes performs a k-way merge of per-partition offset-desc
// streams. Every selected partition contributes a contiguous newest prefix,
// which makes its minimum selected offset a lossless pagination cursor.
func selectNewestPrefixes(rows []map[string]any, limit int) []map[string]any {
	if len(rows) <= limit {
		sortRowsNewest(rows)
		return rows
	}

	grouped := make(map[int32][]map[string]any)
	for _, row := range rows {
		id, ok := row["partition"].(int32)
		if ok {
			grouped[id] = append(grouped[id], row)
		}
	}
	for id := range grouped {
		sort.Slice(grouped[id], func(i, j int) bool {
			left, _ := grouped[id][i]["offset"].(int64)
			right, _ := grouped[id][j]["offset"].(int64)
			return left > right
		})
	}

	positions := make(map[int32]int, len(grouped))
	selected := make([]map[string]any, 0, limit)
	for len(selected) < limit {
		var bestID int32
		var best map[string]any
		found := false
		for id, partitionRows := range grouped {
			position := positions[id]
			if position >= len(partitionRows) {
				continue
			}
			candidate := partitionRows[position]
			if !found || rowIsNewer(candidate, best) {
				bestID, best, found = id, candidate, true
			}
		}
		if !found {
			break
		}
		selected = append(selected, best)
		positions[bestID]++
	}
	return selected
}

func sortRowsNewest(rows []map[string]any) {
	sort.SliceStable(rows, func(i, j int) bool { return rowIsNewer(rows[i], rows[j]) })
}

func rowIsNewer(left, right map[string]any) bool {
	leftTime, _ := left["timestamp"].(string)
	rightTime, _ := right["timestamp"].(string)
	if leftTime != rightTime {
		leftParsed, leftErr := time.Parse(time.RFC3339Nano, leftTime)
		rightParsed, rightErr := time.Parse(time.RFC3339Nano, rightTime)
		if leftErr == nil && rightErr == nil {
			return leftParsed.After(rightParsed)
		}
		return leftTime > rightTime
	}
	leftOffset, _ := left["offset"].(int64)
	rightOffset, _ := right["offset"].(int64)
	if leftOffset != rightOffset {
		return leftOffset > rightOffset
	}
	leftPartition, _ := left["partition"].(int32)
	rightPartition, _ := right["partition"].(int32)
	return leftPartition > rightPartition
}

// rawCandidateRow captures the minimal, undeserialized candidate produced during
// the poll loop: partition/offset/timestamp plus copied key/value bytes. The
// payload bytes are copied so the record can be reused by franz-go on the next
// poll, and are deserialized only later, for the rows that survive page
// selection (see finalizeRow). Headers are small and are deserialized eagerly.
func rawCandidateRow(record *kgo.Record) map[string]any {
	row := map[string]any{
		"partition": record.Partition,
		"offset":    record.Offset,
		"timestamp": record.Timestamp.UTC().Format(time.RFC3339Nano),
	}
	if len(record.Key) > 0 {
		row[rawKeyField] = append([]byte(nil), record.Key...)
	}
	if len(record.Value) > 0 {
		row[rawValueField] = append([]byte(nil), record.Value...)
	}
	if headers := recordHeaders(record); headers != nil {
		row["headers"] = headers
	}
	return row
}

// finalizeRows deserializes each raw candidate into its display row in place.
// It is the only place JSON/text/binary detection happens for the normal browse
// path, so discarded candidates are never deserialized.
func finalizeRows(rows []map[string]any) []map[string]any {
	for i := range rows {
		rows[i] = finalizeRow(rows[i])
	}
	return rows
}

// finalizeRow turns one raw candidate into a display row, deserializing the
// copied key/value bytes and stripping the internal raw fields.
func finalizeRow(raw map[string]any) map[string]any {
	key, _ := deserializePayload(rawBytes(raw, rawKeyField))
	value, format := deserializePayload(rawBytes(raw, rawValueField))

	row := map[string]any{
		"partition": raw["partition"],
		"offset":    raw["offset"],
		"timestamp": raw["timestamp"],
		"key":       key,
		"value":     value,
		"format":    format,
	}
	if headers, ok := raw["headers"]; ok {
		row["headers"] = headers
	}
	return row
}

func rawBytes(raw map[string]any, field string) []byte {
	b, _ := raw[field].([]byte)
	return b
}

// partitionsAllErrored reports whether every partition entry carries an error,
// which is how a non-existent topic surfaces in the offset listing when broker
// auto-create is disabled (the topic appears with a single errored partition).
func partitionsAllErrored(partitions map[int32]kadm.ListedOffset) bool {
	for _, listed := range partitions {
		if listed.Err == nil {
			return false
		}
	}
	return true
}

func parsePartitionFilter(filters []connector.FilterExpr) (int32, error) {
	for _, filter := range filters {
		if !strings.EqualFold(strings.TrimSpace(filter.Column), "partition") {
			continue
		}
		value := strings.TrimSpace(filter.Value)
		if value == "" {
			continue
		}
		partition, err := strconv.ParseInt(value, 10, 32)
		if err != nil || partition < 0 {
			return -1, fmt.Errorf("%w: invalid partition filter %q", connector.ErrBadRequest, filter.Value)
		}
		return int32(partition), nil
	}
	return -1, nil
}

// seekRequest is the user-chosen starting point for a browse, the reader's
// equivalent of Kafka UI's "Seek Type". Both forms name the NEWEST message the
// page may show and the reader walks backwards from there, which is the only
// direction it reads (see GetData):
//
//   - offset: start at this offset inclusive, then older.
//   - timestamp: start at this instant inclusive, then older.
//
// A seek is orthogonal to the field search: it narrows which part of the log is
// read, while match_field/match_value narrow which of those messages are shown.
type seekRequest struct {
	offset    int64
	hasOffset bool
	at        time.Time
	hasTime   bool
}

func (s seekRequest) empty() bool { return !s.hasOffset && !s.hasTime }

// parseSeek reads the from_offset / from_timestamp filters. from_offset is
// rejected without a single-partition filter on purpose: offsets are per
// partition and diverge widely across a topic's partitions, so one number
// applied to all of them would silently return an arbitrary slice of some and
// nothing at all from others. A timestamp has no such ambiguity — it resolves
// independently within each partition — so it stays available for every scope.
func parseSeek(filters []connector.FilterExpr, partitionFilter int32) (seekRequest, error) {
	var seek seekRequest
	for _, filter := range filters {
		column := strings.ToLower(strings.TrimSpace(filter.Column))
		value := strings.TrimSpace(filter.Value)
		if value == "" {
			continue
		}
		switch column {
		case "from_offset":
			if partitionFilter < 0 {
				return seekRequest{}, fmt.Errorf(
					"%w: from_offset requires a single partition — offsets are not comparable across partitions",
					connector.ErrBadRequest,
				)
			}
			offset, err := strconv.ParseInt(value, 10, 64)
			if err != nil || offset < 0 {
				return seekRequest{}, fmt.Errorf("%w: invalid from_offset %q", connector.ErrBadRequest, filter.Value)
			}
			seek.offset, seek.hasOffset = offset, true
		case "from_timestamp":
			at, err := parseSeekTime(value)
			if err != nil {
				return seekRequest{}, err
			}
			seek.at, seek.hasTime = at, true
		}
	}
	return seek, nil
}

// parseSeekTime accepts RFC3339 (what the browser sends) or epoch milliseconds
// (convenient for scripted callers).
func parseSeekTime(value string) (time.Time, error) {
	if at, err := time.Parse(time.RFC3339, value); err == nil {
		return at, nil
	}
	if millis, err := strconv.ParseInt(value, 10, 64); err == nil && millis >= 0 {
		return time.UnixMilli(millis), nil
	}
	return time.Time{}, fmt.Errorf(
		"%w: invalid from_timestamp %q — expected RFC3339 or epoch milliseconds",
		connector.ErrBadRequest, value,
	)
}

// resolveSeekCeilings turns a seek into an exclusive upper offset per partition,
// the same shape as the pagination cursor so both fold into the window bound the
// same way. Returns nil when no seek is set.
func (c *KafkaConnector) resolveSeekCeilings(
	ctx context.Context,
	topic string,
	seek seekRequest,
	partitionFilter int32,
) (map[int32]int64, error) {
	if seek.empty() {
		return nil, nil
	}
	ceilings := make(map[int32]int64, 1)

	if seek.hasOffset {
		// Inclusive of the named offset, and the bound is exclusive.
		ceilings[partitionFilter] = seek.offset + 1
	}

	if seek.hasTime {
		// "At or after T+1ms" is the first message strictly newer than T, so as an
		// exclusive bound it keeps every message at or before T — matching the
		// inclusive semantics the UI offers. kadm reports a partition with nothing
		// newer as its end offset, which is the correct no-op ceiling.
		listCtx, cancel := context.WithTimeout(ctx, metadataTimeout)
		defer cancel()
		listed, err := c.admin.ListOffsetsAfterMilli(listCtx, seek.at.UnixMilli()+1, topic)
		if err != nil {
			return nil, normalizeKafkaError(err)
		}
		for id, offset := range listed[topic] {
			if offset.Err != nil {
				continue
			}
			if partitionFilter >= 0 && id != partitionFilter {
				continue
			}
			// The tighter of the two wins when both forms are given.
			if existing, ok := ceilings[id]; !ok || offset.Offset < existing {
				ceilings[id] = offset.Offset
			}
		}
	}

	return ceilings, nil
}

func parseBeforeOffsets(filters []connector.FilterExpr) (map[int32]int64, error) {
	for _, filter := range filters {
		if !strings.EqualFold(strings.TrimSpace(filter.Column), "before_offsets") {
			continue
		}
		value := strings.TrimSpace(filter.Value)
		if value == "" {
			continue
		}

		raw := make(map[string]int64)
		if err := json.Unmarshal([]byte(value), &raw); err != nil {
			return nil, fmt.Errorf("%w: invalid before_offsets cursor", connector.ErrBadRequest)
		}

		offsets := make(map[int32]int64, len(raw))
		for key, offset := range raw {
			partition, err := strconv.ParseInt(key, 10, 32)
			if err != nil || partition < 0 || offset < 0 {
				return nil, fmt.Errorf("%w: invalid before_offsets cursor", connector.ErrBadRequest)
			}
			offsets[int32(partition)] = offset
		}
		return offsets, nil
	}
	return nil, nil
}

// parseMatchFilter extracts the content-search predicate. An empty field means
// no search (normal windowed paging). The value is compared verbatim.
func parseMatchFilter(filters []connector.FilterExpr) (field string, value string) {
	for _, filter := range filters {
		switch strings.ToLower(strings.TrimSpace(filter.Column)) {
		case "match_field":
			field = strings.TrimSpace(filter.Value)
		case "match_value":
			value = filter.Value
		}
	}
	return field, value
}

// buildPaginationCursor turns one GetData call's per-partition frontier into the
// wire cursor (next_before_offsets) plus the has_older flag.
//
// It emits an entry for EVERY scoped partition that has, or previously had, older
// data, so none can silently drop out of the cursor and be re-read from the top on
// a later page (the pagination bug this fixes). For each scoped partition id:
//
//   - If it had a read window this request (id present in frontier), it is keyed to
//     its advanced frontier offset. A partition fully drained THIS request has
//     frontier[id] == start and is still emitted, pinned at start.
//   - Otherwise, if it carried an incoming cursor (beforeOffsets[id]) it was fully
//     drained on an EARLIER page and skipped this request (its window builder hit
//     upper <= low). It stays pinned at its start offset and is carried forward —
//     without this it would vanish from the cursor the page AFTER it drained, and
//     the next request would re-read it from the current end offset (a duplicate).
//   - Otherwise it is an empty partition (no records — never a window, never a
//     cursor entry). It is correctly omitted: it can never be re-read regardless,
//     since snapshotRead always skips it (upper == end == start <= low).
//
// A missing before_offsets entry is NOT neutral: snapshotRead (and the scan path)
// treat it as "read from the current end offset". Retained at its start offset the
// next request instead builds upper == start, hits `if upper <= low { continue }`,
// and skips it (neither re-read nor errored).
//
// has_older reflects whether ANY scoped partition still has genuinely older data
// (its cursor offset > its start), NOT the size of the cursor map — which, now that
// drained partitions are retained, is non-empty whenever any scoped partition has
// ever held data.
//
// frontier is keyed exactly by the partitions that had a window this request (see
// computeFrontier), so `off, windowed := frontier[id]` is the authoritative
// "did this partition read a window" test.
func buildPaginationCursor(
	scoped []int32,
	frontier map[int32]int64,
	beforeOffsets map[int32]int64,
	startOffset func(int32) int64,
) (map[string]int64, bool) {
	cursor := make(map[string]int64, len(scoped))
	hasOlder := false
	for _, id := range scoped {
		start := startOffset(id)
		if off, windowed := frontier[id]; windowed {
			cursor[strconv.Itoa(int(id))] = off
			if off > start {
				hasOlder = true
			}
			continue
		}
		if _, carried := beforeOffsets[id]; carried {
			cursor[strconv.Itoa(int(id))] = start
		}
	}
	return cursor, hasOlder
}

// consumeWithIncarnationRetry runs one read attempt and, if it fails because the
// topic was deleted and recreated under the same name, purges the reader's stale
// name -> topic-UUID mapping and retries EXACTLY once.
//
// The retry deliberately drops the caller's cursor: before_offsets describe the
// previous incarnation of the topic, whose records no longer exist, so reusing
// them could only skip messages in the new one. The returned cursorReset flag
// tells the caller the page is a fresh start rather than a continuation.
//
// A second failure is not retried again — it is reported as a typed unavailable
// error naming the topic, instead of the raw broker message that used to surface
// as an opaque 500.
func (c *KafkaConnector) consumeWithIncarnationRetry(
	topic string,
	cursor map[int32]int64,
	attempt func(map[int32]int64) (*consumeResult, map[int32]partitionWindow, error),
) (*consumeResult, map[int32]partitionWindow, bool, error) {
	consumed, windows, err := attempt(cursor)
	if !errors.Is(err, errTopicIncarnationChanged) {
		return consumed, windows, false, err
	}

	c.consume.PurgeTopicsFromConsuming(topic)
	slog.Info("kafka topic incarnation changed",
		"topic", topic,
		"action", "purged stale consumer topic id, retrying once",
	)

	consumed, windows, err = attempt(nil)
	if errors.Is(err, errTopicIncarnationChanged) {
		slog.Warn("kafka topic incarnation retry failed", "topic", topic)
		return nil, nil, false, fmt.Errorf(
			"%w: topic %q was recreated and its new id is not resolvable yet; retry in a moment",
			connector.ErrUnavailable, topic,
		)
	}
	if err != nil {
		return nil, nil, false, err
	}
	return consumed, windows, true, nil
}

// computeFrontier derives the per-partition pagination cursor for one GetData
// call. It defaults every scoped partition to its original (pre-request)
// upper bound, then advances it in two ways, in priority order:
//  1. If the partition contributed rows that survived page selection, advance
//     to the lowest such row's offset (the precise, lossless cursor).
//  2. Otherwise, if the partition completed with zero records in its window
//     (completedFrom and NOT recordsRead), advance to that confirmed lower
//     bound — without this, an empty/compacted window would never move its
//     cursor and would be rescanned forever by "Load older" / "Scan more".
//
// A partition that neither returned rows nor completed keeps its prior upper
// offset untouched, per the cursor contract: never skip, never re-show a row.
//
// The invariant this function enforces:
//
//	A partition's cursor may only advance past an offset that was either
//	(a) actually RETURNED to the caller in this response, or (b) confirmed to
//	contain no record at all. It must never advance past a record that was read
//	from the broker but withheld from the page.
//
// Case (a) is the row-based advance; case (b) is the completedFrom advance,
// which is why it is gated on recordsRead. The gap between them — a window that
// completed and yielded records, none of which survived selectNewestPrefixes'
// trim to the page limit — is precisely the silent-skip bug: completedFrom would
// move the cursor below records the caller never saw, making them permanently
// unreachable. Such a partition keeps its prior upper offset so the very next
// page re-reads that window and can return those records.
func computeFrontier(
	frontierWindows map[int32]partitionWindow,
	rows []map[string]any,
	scanning bool,
	completed map[int32]bool,
	completedFrom map[int32]int64,
	recordsRead map[int32]bool,
) map[int32]int64 {
	frontier := make(map[int32]int64, len(frontierWindows))
	for id, window := range frontierWindows {
		frontier[id] = window.upper
	}
	reached := lowestConsumedOffsets(rows)
	for id, off := range reached {
		if !scanning || completed[id] {
			frontier[id] = off
		}
	}
	for id, from := range completedFrom {
		if _, hasRows := reached[id]; hasRows {
			continue // the row-based cursor above is authoritative when rows exist
		}
		if recordsRead[id] {
			// The window completed and DID hold records, but none of them are in
			// this response (they were trimmed out of the final page). Advancing to
			// `from` here would skip them forever. Leave the cursor at the prior
			// upper bound so the next page re-reads this window.
			continue
		}
		frontier[id] = from
	}
	return frontier
}

// lowestConsumedOffsets reports the smallest offset consumed per partition.
func lowestConsumedOffsets(rows []map[string]any) map[int32]int64 {
	reached := make(map[int32]int64)
	for _, row := range rows {
		id, ok := row["partition"].(int32)
		if !ok {
			continue
		}
		offset, ok := row["offset"].(int64)
		if !ok {
			continue
		}
		if cur, seen := reached[id]; !seen || offset < cur {
			reached[id] = offset
		}
	}
	return reached
}

// filterMatches keeps only rows whose JSON value has field == value.
func filterMatches(rows []map[string]any, field string, value string) []map[string]any {
	matches := make([]map[string]any, 0, 16)
	for _, row := range rows {
		if messageMatchesField(row, field, value) {
			matches = append(matches, row)
		}
	}
	return matches
}

// messageMatchesField reports whether a message contains a JSON leaf at the
// canonical path equal to want. The path grammar matches the shared TypeScript
// library (frontend/src/lib/jsonPaths.ts): a plain object key separated by '.',
// an array element denoted by '[]', and a key containing '.', '[', ']', a quote
// or whitespace addressed with bracket notation (["key.with.dot"]).
//
// Full paths from the root ("src.event_data.events[].name") always resolve
// correctly. Two legacy affordances are preserved for hand-typed search queries
// so existing usage keeps working: a path may start below the root
// ("events[].name" matches a nested array anywhere), and an array may be
// traversed implicitly without the '[]' marker ("events.name" == "events[].name").
// The canonical TypeScript traversal is strict (root-anchored, '[]' required);
// the shared fixture set uses full '[]' paths, on which both agree.
func messageMatchesField(row map[string]any, field string, want string) bool {
	if field == "" {
		return true
	}
	if format, _ := row["format"].(string); format != "json" {
		return false
	}
	raw, ok := row["value"].(string)
	if !ok {
		return false
	}
	var parsed any
	if json.Unmarshal([]byte(raw), &parsed) != nil {
		return false
	}
	segments := parseJSONPath(field)
	if len(segments) == 0 {
		return false
	}
	return jsonPathMatchesAnywhere(parsed, segments, want)
}

type jsonPathSegmentKind int

const (
	jsonPathKey jsonPathSegmentKind = iota
	jsonPathIndex
)

// jsonPathSegment is one step of a parsed canonical path: an object key or an
// array element wildcard ('[]').
type jsonPathSegment struct {
	kind jsonPathSegmentKind
	key  string
}

// parseJSONPath parses a canonical path string into segments. It tolerates a
// leading '$' and stray '.' separators, accepts legacy "[*]" as an alias for
// "[]", and unwraps bracket-quoted keys (["key.with.dot"] or ['key']). It is the
// Go counterpart of parsePath in frontend/src/lib/jsonPaths.ts.
func parseJSONPath(field string) []jsonPathSegment {
	s := strings.TrimSpace(field)
	segments := make([]jsonPathSegment, 0, 8)
	i := 0
	n := len(s)
	for i < n {
		c := s[i]
		switch {
		case c == '.' || c == '$':
			i++
		case c == '[':
			switch {
			case i+1 < n && s[i+1] == ']':
				segments = append(segments, jsonPathSegment{kind: jsonPathIndex})
				i += 2
			case i+2 < n && s[i+1] == '*' && s[i+2] == ']':
				segments = append(segments, jsonPathSegment{kind: jsonPathIndex})
				i += 3
			case i+1 < n && (s[i+1] == '"' || s[i+1] == '\''):
				quote := s[i+1]
				j := i + 2
				var sb strings.Builder
				for j < n && s[j] != quote {
					if s[j] == '\\' && j+1 < n {
						sb.WriteByte(s[j+1])
						j += 2
						continue
					}
					sb.WriteByte(s[j])
					j++
				}
				j++ // consume closing quote
				if j < n && s[j] == ']' {
					j++ // consume closing bracket
				}
				segments = append(segments, jsonPathSegment{kind: jsonPathKey, key: sb.String()})
				i = j
			default:
				// Bare bracket content (e.g. [foo]) — treat as a key for leniency.
				j := i + 1
				var sb strings.Builder
				for j < n && s[j] != ']' {
					sb.WriteByte(s[j])
					j++
				}
				if j < n {
					j++ // consume closing bracket
				}
				if key := strings.TrimSpace(sb.String()); key != "" {
					segments = append(segments, jsonPathSegment{kind: jsonPathKey, key: key})
				}
				i = j
			}
		default:
			// Plain key: everything up to the next '.' or '['.
			j := i
			for j < n && s[j] != '.' && s[j] != '[' {
				j++
			}
			if key := strings.TrimSpace(s[i:j]); key != "" {
				segments = append(segments, jsonPathSegment{kind: jsonPathKey, key: key})
			}
			i = j
		}
	}
	return segments
}

// jsonPathMatchesAnywhere first tries a root-anchored match, then recurses into
// every child so a hand-typed suffix path ("events[].name", "name") still finds
// a nested match. Full paths from the root match on the first (root-anchored)
// attempt, so this suffix fallback never changes their result.
func jsonPathMatchesAnywhere(value any, segments []jsonPathSegment, want string) bool {
	if jsonPathMatchesFrom(value, segments, want) {
		return true
	}
	switch typed := value.(type) {
	case map[string]any:
		for _, child := range typed {
			if jsonPathMatchesAnywhere(child, segments, want) {
				return true
			}
		}
	case []any:
		for _, child := range typed {
			if jsonPathMatchesAnywhere(child, segments, want) {
				return true
			}
		}
	}
	return false
}

// jsonPathMatchesFrom resolves segments against value starting at value itself.
// A 'key' segment descends objects; an 'index' segment consumes an array by
// iterating its elements. For backward compatibility a 'key' segment landing on
// an array is also traversed implicitly (each element retried with the same
// segment), so "events.name" behaves like "events[].name".
func jsonPathMatchesFrom(value any, segments []jsonPathSegment, want string) bool {
	if len(segments) == 0 {
		return jsonLeafEquals(value, want)
	}
	seg := segments[0]
	switch typed := value.(type) {
	case map[string]any:
		if seg.kind != jsonPathKey {
			return false
		}
		child, ok := typed[seg.key]
		return ok && jsonPathMatchesFrom(child, segments[1:], want)
	case []any:
		if seg.kind == jsonPathIndex {
			for _, child := range typed {
				if jsonPathMatchesFrom(child, segments[1:], want) {
					return true
				}
			}
			return false
		}
		// Legacy implicit array traversal for a key segment.
		for _, child := range typed {
			if jsonPathMatchesFrom(child, segments, want) {
				return true
			}
		}
	}
	return false
}

// jsonLeafEquals compares a decoded JSON scalar to the entered string. Numbers
// compare numerically so "123" matches 123; nested objects/arrays never match.
func jsonLeafEquals(leaf any, want string) bool {
	switch typed := leaf.(type) {
	case nil:
		return want == "null"
	case bool:
		return strconv.FormatBool(typed) == want
	case float64:
		parsed, err := strconv.ParseFloat(want, 64)
		return err == nil && parsed == typed
	case string:
		return typed == want
	default:
		return false
	}
}
