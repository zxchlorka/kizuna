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

// readDirection is which end of the log a browse starts from and which way it
// pages. Both directions read each partition window forward off the broker —
// consumeWindows is direction-agnostic — so the difference lives entirely in
// where windows are anchored, which end of the merged candidates becomes the
// page, and which way the pagination cursor advances.
//
//   - directionNewest anchors at the partition end and pages towards older
//     records. Its cursor (next_before_offsets) is an EXCLUSIVE UPPER bound and
//     only ever decreases.
//   - directionOldest anchors at the partition start and pages towards newer
//     records. Its cursor (next_after_offsets) is an INCLUSIVE LOWER bound — the
//     first offset not yet returned — and only ever increases.
type readDirection int

const (
	directionNewest readDirection = iota
	directionOldest
)

func (d readDirection) oldestFirst() bool { return d == directionOldest }

// cursorField is the meta key carrying this direction's pagination cursor, and
// moreField the flag saying whether that direction has anything left. They are
// distinct wire names on purpose: a client must never feed a cursor from one
// direction into a read going the other way, and distinct names make that a
// missing field rather than a silently wrong window.
func (d readDirection) cursorField() string {
	if d.oldestFirst() {
		return "next_after_offsets"
	}
	return "next_before_offsets"
}

func (d readDirection) moreField() string {
	if d.oldestFirst() {
		return "has_newer"
	}
	return "has_older"
}

// exhausted reports whether a partition's frontier has reached the end of the
// log in this direction, i.e. there is nothing further to page into.
func (d readDirection) exhausted(frontier, start, end int64) bool {
	if d.oldestFirst() {
		return frontier >= end
	}
	return frontier <= start
}

// pinnedOffset is where a partition already drained in this direction parks in
// the cursor, so it is skipped rather than re-read from scratch on later pages.
func (d readDirection) pinnedOffset(start, end int64) int64 {
	if d.oldestFirst() {
		return end
	}
	return start
}

func parseDirection(filters []connector.FilterExpr) (readDirection, error) {
	for _, filter := range filters {
		if !strings.EqualFold(strings.TrimSpace(filter.Column), "order") {
			continue
		}
		switch strings.ToLower(strings.TrimSpace(filter.Value)) {
		case "", "newest":
			return directionNewest, nil
		case "oldest":
			return directionOldest, nil
		default:
			return directionNewest, fmt.Errorf(
				"%w: invalid order %q — expected \"newest\" or \"oldest\"",
				connector.ErrBadRequest, filter.Value,
			)
		}
	}
	return directionNewest, nil
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
	// completedWindow records, for each partition that completed in THIS call,
	// the exact offset range it was confirmed to have read — even when that
	// range produced zero rows. The row-derived cursor only ever sees actual
	// rows, so without this a partition that completes with zero rows in its
	// window would never advance its cursor and would be rescanned forever.
	//
	// The whole window is kept rather than a single bound because which edge is
	// the "confirmed frontier" depends on the read direction: the window's lower
	// bound when paging towards older records, its upper bound when paging
	// towards newer ones. Storing both keeps consumeWindows free of any notion of
	// direction — computeFrontier picks the edge. Populated at the same place
	// completed[id] is set, so it is only ever set for genuinely completed
	// partitions.
	completedWindow map[int32]partitionWindow
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
	// completedWindow alone cannot tell apart:
	//
	//   - completed window with ZERO records (empty / fully-compacted range):
	//     advancing the cursor to that window's far edge is safe and necessary (Task 3's
	//     stuck-cursor fix — nothing is lost).
	//   - completed window that DID contain records, none of which survived final
	//     page selection: advancing past it would move the cursor beyond
	//     records that were read from the broker but never returned to the
	//     caller, making them permanently unreachable (silent data loss).
	//
	// Set at the same place completed[id]/completedWindow[id] are, so it is keyed
	// only by genuinely completed partitions and always describes the same window
	// completedWindow describes. See computeFrontier for how it is consumed.
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
	direction, err := parseDirection(opts.Filters)
	if err != nil {
		return nil, err
	}
	// One cursor variable for both directions; parseCursorOffsets picks the wire
	// field matching the read direction so a cursor can never be fed into a read
	// going the other way.
	cursorOffsets, err := parseCursorOffsets(opts.Filters, direction)
	if err != nil {
		return nil, err
	}
	matchField, matchValue, matchOperator := parseMatchFilter(opts.Filters)
	scanning := matchField != ""
	seek, err := parseSeek(opts.Filters)
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
	// cursor tracks how far it has walked, and whichever is tighter wins.
	seekBounds, err := c.resolveSeekBounds(ctx, topic, seek, direction, scoped)
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
				low, end := partitionOffsets(topic, id, starts, ends)
				lower, upper := low, end
				if direction.oldestFirst() {
					if floorOffset, ok := seekBounds[id]; ok && floorOffset > lower {
						lower = floorOffset
					}
					if after, ok := cursor[id]; ok && after > lower {
						lower = after
					}
				} else {
					if ceiling, ok := seekBounds[id]; ok && ceiling < upper {
						upper = ceiling
					}
					if before, ok := cursor[id]; ok && before < upper {
						upper = before
					}
				}
				if upper <= lower {
					continue
				}
				// The scan window grows away from whichever edge this direction
				// starts at, capped by the partition's own range.
				if direction.oldestFirst() {
					if upper > lower+perPartition {
						upper = lower + perPartition
					}
				} else if lower < upper-perPartition {
					lower = upper - perPartition
				}
				windows[id] = partitionWindow{from: lower, upper: upper}
			}
			result, scanErr := resolveScanConsume(c.consumeWindows(ctx, topic, windows, maxScanMessages, scanTimeBudget))
			if scanErr != nil {
				return nil, nil, scanErr
			}
			return result, windows, nil
		}
		// Normal browse: bounded-quota fast snapshot with adaptive refill.
		return c.snapshotRead(ctx, topic, scoped, starts, ends, direction, seekBounds, cursor, limit)
	}

	consumed, frontierWindows, cursorReset, err := c.consumeWithIncarnationRetry(topic, cursorOffsets, readAttempt)
	if err != nil {
		return nil, err
	}
	if cursorReset {
		// The retry read the recreated topic from the direction's starting end, so
		// this page is a fresh start; the caller must replace rows rather than
		// append to a page built from the previous incarnation.
		cursorOffsets = nil
	}
	consumeMs := time.Since(consumeStart).Milliseconds()

	rows := consumed.rows
	if !scanning {
		rows = selectDirectionalPrefixes(rows, limit, direction)
	}

	sortRowsDirectional(rows, direction)

	// Advance only partitions whose rows are actually returned to the caller (or
	// whose window is confirmed to hold no record at all). Unread partitions, and
	// partitions whose records were read but trimmed out of this page, keep their
	// prior bound, so neither partial broker replies nor page selection can
	// create pagination gaps.
	frontier := computeFrontier(
		frontierWindows, rows, scanning, direction,
		consumed.completed, consumed.completedWindow, consumed.recordsRead,
	)

	nextCursor, hasMore := buildPaginationCursor(scoped, frontier, cursorOffsets, direction, func(id int32) (int64, int64) {
		return partitionOffsets(topic, id, starts, ends)
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
		"partitions_total": len(scoped),
		// Scoped partitions that actually had something to read this request.
		// With an offset seek across many partitions this is the honest answer to
		// "did that number mean anything here": one number lands inside only the
		// partitions whose range contains it, and the caller deserves to see that
		// rather than wonder why the page looks thin.
		"partitions_windowed":  len(frontierWindows),
		"partitions_completed": len(consumed.completed),
		direction.moreField():  hasMore,
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
		rows = filterMatches(finalizeRows(rows), matchField, matchValue, matchOperator)
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
	// its size is no longer a "has more" signal; gate on hasMore instead. This keeps
	// the prior wire invariant the frontend relies on: next_before_offsets is present
	// exactly when has_older is true (kafka.ts's "Scan more"/"Load older" guards).
	if hasMore {
		meta[direction.cursorField()] = nextCursor
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
		HasMore: hasMore,
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
		rows:            make([]map[string]any, 0, target),
		completed:       make(map[int32]bool, len(windows)),
		completedWindow: make(map[int32]partitionWindow, len(windows)),
		recordsRead:     make(map[int32]bool, len(windows)),
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
			result.completedWindow[id] = window
			if len(rowsByPartition[id]) > 0 {
				// This completed window held real records inside [from, upper).
				// Whether they survive final page selection is decided later, so
				// the cursor must not blind-advance past this window on the
				// strength of completedWindow alone (see computeFrontier).
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
			rows:            make([]map[string]any, 0),
			completed:       make(map[int32]bool),
			completedWindow: make(map[int32]partitionWindow),
			recordsRead:     make(map[int32]bool),
			timedOut:        true,
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
	direction readDirection,
	seekBounds map[int32]int64,
	cursorOffsets map[int32]int64,
	limit int,
) (*consumeResult, map[int32]partitionWindow, error) {
	quota := initialPartitionQuota(limit, len(scoped))

	// start is where the partition's readable range begins in this direction and
	// limitOf where it ends; floor is the edge the next round grows away from and
	// moves outward as we widen.
	start := make(map[int32]int64, len(scoped))
	limitOf := make(map[int32]int64, len(scoped))
	floor := make(map[int32]int64, len(scoped))
	frontierWindows := make(map[int32]partitionWindow, len(scoped))
	for _, id := range scoped {
		low, end := partitionOffsets(topic, id, starts, ends)
		lower, upper := low, end
		if direction.oldestFirst() {
			// Paging towards newer records: the seek and the cursor both raise the
			// window's FLOOR, and the ceiling stays at the partition end.
			if floorOffset, ok := seekBounds[id]; ok && floorOffset > lower {
				lower = floorOffset
			}
			if after, ok := cursorOffsets[id]; ok && after > lower {
				lower = after
			}
		} else {
			if ceiling, ok := seekBounds[id]; ok && ceiling < upper {
				upper = ceiling
			}
			if before, ok := cursorOffsets[id]; ok && before < upper {
				upper = before
			}
		}
		if upper <= lower {
			continue
		}
		start[id] = lower
		limitOf[id] = end
		// The bound the first round grows away from: the ceiling when paging down,
		// the floor when paging up.
		floor[id] = upper
		if direction.oldestFirst() {
			floor[id] = lower
		}
		frontierWindows[id] = partitionWindow{from: lower, upper: upper}
	}

	aggregate := &consumeResult{
		rows:            make([]map[string]any, 0, limit),
		completed:       make(map[int32]bool, len(frontierWindows)),
		completedWindow: make(map[int32]partitionWindow, len(frontierWindows)),
		recordsRead:     make(map[int32]bool, len(frontierWindows)),
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
			if direction.oldestFirst() {
				if floor[id] >= limitOf[id] {
					continue // nothing newer left to read in this partition
				}
				upper := floor[id] + widen
				if upper > limitOf[id] {
					upper = limitOf[id]
				}
				windows[id] = partitionWindow{from: floor[id], upper: upper}
				scannedOffsets += upper - floor[id]
				continue
			}
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
			break // every partition has been read to the end of the direction
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
				// true). completedWindow is intentionally left untouched: an earlier
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
				aggregate.completedWindow[id] = consumed.completedWindow[id]
				// recordsRead, unlike completed/completedWindow, is STICKY across
				// rounds — it is OR-ed, never overwritten or deleted. completedWindow
				// deepens with every widening round, so a later round that reads a
				// genuinely empty deeper window would otherwise let the cursor
				// leapfrog past records an EARLIER round of the same request read
				// and withheld from the page. Because the rounds tile the range
				// tile the scanned range contiguously, the OR over all
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
		// Move each attempted partition's edge to the far side of the range this
		// round just covered, so the next round tiles onto it instead of over it.
		// Direction decides which side that is — using the wrong one makes every
		// widening round re-read the range before it, which surfaces as duplicated
		// rows in the page.
		for id := range windows {
			if direction.oldestFirst() {
				floor[id] = windows[id].upper
			} else {
				floor[id] = windows[id].from
			}
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

// selectDirectionalPrefixes performs a k-way merge of per-partition offset-
// ordered streams, taking the page from the end of the log the read direction
// starts at. Every selected partition contributes a CONTIGUOUS prefix in that
// direction, which is what makes its extreme selected offset a lossless
// pagination cursor — a non-contiguous selection would leave holes the cursor
// could never point at.
func selectDirectionalPrefixes(rows []map[string]any, limit int, direction readDirection) []map[string]any {
	if len(rows) <= limit {
		sortRowsDirectional(rows, direction)
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
			if direction.oldestFirst() {
				return left < right
			}
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
			if !found || rowIsAhead(candidate, best, direction) {
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

func sortRowsDirectional(rows []map[string]any, direction readDirection) {
	sort.SliceStable(rows, func(i, j int) bool { return rowIsAhead(rows[i], rows[j], direction) })
}

// rowIsAhead reports whether `left` comes before `right` in the read direction's
// display order: newest first, or oldest first.
func rowIsAhead(left, right map[string]any, direction readDirection) bool {
	if direction.oldestFirst() {
		return rowIsNewer(right, left)
	}
	return rowIsNewer(left, right)
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

// parseSeek reads the from_offset / from_timestamp filters.
//
// An offset seek applies to every scoped partition. Offsets are per-partition
// identifiers, so one number means a different position in each — on a topic
// whose partitions have drifted apart it lands inside only a few of them and
// the rest legitimately contribute nothing. That is not an error and the window
// maths handles it exactly (see resolveSeekBounds), but it IS something the
// caller should see, so GetData reports partitions_windowed alongside the page.
func parseSeek(filters []connector.FilterExpr) (seekRequest, error) {
	var seek seekRequest
	for _, filter := range filters {
		column := strings.ToLower(strings.TrimSpace(filter.Column))
		value := strings.TrimSpace(filter.Value)
		if value == "" {
			continue
		}
		switch column {
		case "from_offset":
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

// resolveSeekBounds turns a seek into one bound per partition, in the same shape
// as the pagination cursor so both fold into the window the same way.
//
// The bound's meaning follows the read direction, and in both cases the seeked
// point itself is INCLUDED:
//
//   - directionNewest: an exclusive UPPER bound. "Start at this point and read
//     older", so the ceiling sits one past the named offset, and for a timestamp
//     it is the first offset strictly newer than T.
//   - directionOldest: an inclusive LOWER bound. "Start at this point and read
//     newer", so the floor IS the named offset, and for a timestamp it is the
//     first offset at or after T.
//
// Returns nil when no seek is set.
func (c *KafkaConnector) resolveSeekBounds(
	ctx context.Context,
	topic string,
	seek seekRequest,
	direction readDirection,
	scoped []int32,
) (map[int32]int64, error) {
	if seek.empty() {
		return nil, nil
	}
	inScope := make(map[int32]bool, len(scoped))
	for _, id := range scoped {
		inScope[id] = true
	}
	bounds := make(map[int32]int64, len(scoped))

	if seek.hasOffset {
		// The same number for every scoped partition. Where it falls outside a
		// partition's range the window maths resolves it without inventing data:
		// a bound past the far end covers the whole partition, and a bound past
		// the near end leaves nothing to read and the partition is skipped. That
		// is stricter than Kafka UI, which clamps an out-of-range offset to the
		// nearest edge and so presents that partition's edge as if it answered
		// the query.
		for _, id := range scoped {
			if direction.oldestFirst() {
				bounds[id] = seek.offset
			} else {
				bounds[id] = seek.offset + 1
			}
		}
	}

	if seek.hasTime {
		// Paging newer wants the first record at or after T; paging older wants an
		// exclusive ceiling, which is the first record strictly newer than T — i.e.
		// at or after T+1ms. kadm reports a partition with nothing at or after the
		// requested instant as its end offset, which is the correct no-op bound in
		// both directions (nothing newer to page into / no ceiling to impose).
		millis := seek.at.UnixMilli()
		if !direction.oldestFirst() {
			millis++
		}
		listCtx, cancel := context.WithTimeout(ctx, metadataTimeout)
		defer cancel()
		listed, err := c.admin.ListOffsetsAfterMilli(listCtx, millis, topic)
		if err != nil {
			return nil, normalizeKafkaError(err)
		}
		for id, offset := range listed[topic] {
			if offset.Err != nil {
				continue
			}
			if !inScope[id] {
				continue
			}
			// When both forms are given, keep whichever bound is more restrictive
			// for this direction.
			existing, ok := bounds[id]
			switch {
			case !ok:
				bounds[id] = offset.Offset
			case direction.oldestFirst() && offset.Offset > existing:
				bounds[id] = offset.Offset
			case !direction.oldestFirst() && offset.Offset < existing:
				bounds[id] = offset.Offset
			}
		}
	}

	return bounds, nil
}

// parseCursorOffsets reads the pagination cursor for the given read direction.
//
// Each direction has its own wire field — before_offsets when paging towards
// older records, after_offsets when paging towards newer ones — and this only
// ever looks at the one matching `direction`. That is the point: the two cursors
// mean opposite things (an exclusive upper bound versus an inclusive lower one),
// so a client that switched direction and kept sending the old field gets a
// fresh read from that direction's end rather than a window silently computed
// from a bound pointing the wrong way.
func parseCursorOffsets(filters []connector.FilterExpr, direction readDirection) (map[int32]int64, error) {
	column := "before_offsets"
	if direction.oldestFirst() {
		column = "after_offsets"
	}

	for _, filter := range filters {
		if !strings.EqualFold(strings.TrimSpace(filter.Column), column) {
			continue
		}
		value := strings.TrimSpace(filter.Value)
		if value == "" {
			continue
		}

		raw := make(map[string]int64)
		if err := json.Unmarshal([]byte(value), &raw); err != nil {
			return nil, fmt.Errorf("%w: invalid %s cursor", connector.ErrBadRequest, column)
		}

		offsets := make(map[int32]int64, len(raw))
		for key, offset := range raw {
			partition, err := strconv.ParseInt(key, 10, 32)
			if err != nil || partition < 0 || offset < 0 {
				return nil, fmt.Errorf("%w: invalid %s cursor", connector.ErrBadRequest, column)
			}
			offsets[int32(partition)] = offset
		}
		return offsets, nil
	}
	return nil, nil
}

// matchOp is what a message must satisfy for the searched field.
//
// matchOpExists/matchOpMissing answer "does this field occur at all", which is
// the only way to look for a field whose values you do not know yet — a newly
// rolled-out optional field, for instance. matchOpEquals is the original
// behavior and stays the default, so a request without match_op is unchanged.
type matchOp string

const (
	matchOpEquals  matchOp = "eq"
	matchOpExists  matchOp = "exists"
	matchOpMissing matchOp = "missing"
)

// parseMatchFilter extracts the content-search predicate. An empty field means
// no search (normal windowed paging). The value is compared verbatim, and is
// ignored entirely unless the op is matchOpEquals. An absent or unrecognized
// match_op falls back to matchOpEquals.
func parseMatchFilter(filters []connector.FilterExpr) (field string, value string, op matchOp) {
	op = matchOpEquals
	for _, filter := range filters {
		switch strings.ToLower(strings.TrimSpace(filter.Column)) {
		case "match_field":
			field = strings.TrimSpace(filter.Value)
		case "match_value":
			value = filter.Value
		case "match_op":
			switch matchOp(strings.ToLower(strings.TrimSpace(filter.Value))) {
			case matchOpExists:
				op = matchOpExists
			case matchOpMissing:
				op = matchOpMissing
			}
		}
	}
	return field, value, op
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
	incoming map[int32]int64,
	direction readDirection,
	bounds func(int32) (int64, int64),
) (map[string]int64, bool) {
	cursor := make(map[string]int64, len(scoped))
	hasMore := false
	for _, id := range scoped {
		start, end := bounds(id)
		if off, windowed := frontier[id]; windowed {
			cursor[strconv.Itoa(int(id))] = off
			if !direction.exhausted(off, start, end) {
				hasMore = true
			}
			continue
		}
		if _, carried := incoming[id]; carried {
			cursor[strconv.Itoa(int(id))] = direction.pinnedOffset(start, end)
		}
	}
	return cursor, hasMore
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
// call. It defaults every scoped partition to the bound it started this request
// from, then advances it in two ways, in priority order:
//  1. If the partition contributed rows that survived page selection, advance to
//     the furthest such row in the read direction (the precise, lossless cursor).
//  2. Otherwise, if the partition completed with zero records in its window
//     (completedWindow and NOT recordsRead), advance to that window's confirmed
//     far edge — without this, an empty/compacted window would never move its
//     cursor and would be rescanned forever by "Load older"/"Load newer".
//
// A partition that neither returned rows nor completed keeps its prior offset
// untouched, per the cursor contract: never skip, never re-show a row.
//
// The invariant this function enforces, in EITHER direction:
//
//	A partition's cursor may only advance past an offset that was either
//	(a) actually RETURNED to the caller in this response, or (b) confirmed to
//	contain no record at all. It must never advance past a record that was read
//	from the broker but withheld from the page.
//
// Case (a) is the row-based advance; case (b) is the completedWindow advance,
// which is why it is gated on recordsRead. The gap between them — a window that
// completed and yielded records, none of which survived the trim to the page
// limit — is precisely the silent-skip bug: the window-based advance would move
// the cursor past records the caller never saw, making them permanently
// unreachable. Such a partition keeps its prior bound so the very next page
// re-reads that window and can return those records.
//
// Direction only changes which edge counts as "further": the lowest offset and a
// window's `from` when paging towards older records, the highest offset plus one
// and a window's `upper` when paging towards newer ones. The reasoning above is
// deliberately expressed once, for both.
func computeFrontier(
	frontierWindows map[int32]partitionWindow,
	rows []map[string]any,
	scanning bool,
	direction readDirection,
	completed map[int32]bool,
	completedWindow map[int32]partitionWindow,
	recordsRead map[int32]bool,
) map[int32]int64 {
	frontier := make(map[int32]int64, len(frontierWindows))
	for id, window := range frontierWindows {
		// The edge this request started from, and therefore the safe no-advance
		// fallback for a partition that produced nothing usable.
		if direction.oldestFirst() {
			frontier[id] = window.from
		} else {
			frontier[id] = window.upper
		}
	}
	reached := consumedFrontierOffsets(rows, direction)
	for id, off := range reached {
		if !scanning || completed[id] {
			frontier[id] = off
		}
	}
	for id, window := range completedWindow {
		if _, hasRows := reached[id]; hasRows {
			continue // the row-based cursor above is authoritative when rows exist
		}
		if recordsRead[id] {
			// The window completed and DID hold records, but none of them are in
			// this response (they were trimmed out of the final page). Advancing
			// past them here would skip them forever. Leave the cursor at the prior
			// bound so the next page re-reads this window.
			continue
		}
		if direction.oldestFirst() {
			frontier[id] = window.upper
		} else {
			frontier[id] = window.from
		}
	}
	return frontier
}

// consumedFrontierOffsets reports, per partition, the offset the cursor may
// safely advance to given the rows actually returned: the smallest offset when
// paging towards older records, and one past the largest when paging towards
// newer ones (the cursor is an inclusive lower bound in that direction, so the
// next page must start after the last row already shown).
func consumedFrontierOffsets(rows []map[string]any, direction readDirection) map[int32]int64 {
	if direction.oldestFirst() {
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
			if cur, seen := reached[id]; !seen || offset+1 > cur {
				reached[id] = offset + 1
			}
		}
		return reached
	}
	return lowestConsumedOffsets(rows)
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
func filterMatches(rows []map[string]any, field string, value string, op matchOp) []map[string]any {
	matches := make([]map[string]any, 0, 16)
	for _, row := range rows {
		if messageMatchesField(row, field, value, op) {
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
// The op decides what the resolved path must satisfy: equal to want, merely
// present (any value, including null), or absent. A payload that is not JSON
// matches NO op — including matchOpMissing. It technically lacks the field, but
// so does every unrelated non-JSON record, and returning them all would bury the
// messages the search is actually about.
func messageMatchesField(row map[string]any, field string, want string, op matchOp) bool {
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

	switch op {
	case matchOpExists:
		return jsonPathMatchesAnywhere(parsed, segments, anyLeaf)
	case matchOpMissing:
		return !jsonPathMatchesAnywhere(parsed, segments, anyLeaf)
	default:
		return jsonPathMatchesAnywhere(parsed, segments, equalsLeaf(want))
	}
}

// leafPredicate decides whether a fully resolved path counts as a match.
type leafPredicate func(leaf any) bool

// anyLeaf accepts whatever the path resolved to: reaching the leaf at all is
// what "the field exists" means, so null and empty objects count as present.
func anyLeaf(any) bool { return true }

func equalsLeaf(want string) leafPredicate {
	return func(leaf any) bool { return jsonLeafEquals(leaf, want) }
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
func jsonPathMatchesAnywhere(value any, segments []jsonPathSegment, leaf leafPredicate) bool {
	if jsonPathMatchesFrom(value, segments, leaf) {
		return true
	}
	switch typed := value.(type) {
	case map[string]any:
		for _, child := range typed {
			if jsonPathMatchesAnywhere(child, segments, leaf) {
				return true
			}
		}
	case []any:
		for _, child := range typed {
			if jsonPathMatchesAnywhere(child, segments, leaf) {
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
func jsonPathMatchesFrom(value any, segments []jsonPathSegment, leaf leafPredicate) bool {
	if len(segments) == 0 {
		return leaf(value)
	}
	seg := segments[0]
	switch typed := value.(type) {
	case map[string]any:
		if seg.kind != jsonPathKey {
			return false
		}
		child, ok := typed[seg.key]
		return ok && jsonPathMatchesFrom(child, segments[1:], leaf)
	case []any:
		if seg.kind == jsonPathIndex {
			for _, child := range typed {
				if jsonPathMatchesFrom(child, segments[1:], leaf) {
					return true
				}
			}
			return false
		}
		// Legacy implicit array traversal for a key segment.
		for _, child := range typed {
			if jsonPathMatchesFrom(child, segments, leaf) {
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
