package kafka

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/twmb/franz-go/pkg/kadm"
	"github.com/twmb/franz-go/pkg/kgo"
	"github.com/zxchlorka/kizuna/internal/connector"
	"golang.org/x/sync/errgroup"
)

const (
	defaultMessageLimit = 50
	maxMessageLimit     = 500

	// readBudget bounds one fast-snapshot refresh across all of its adaptive
	// rounds. It is deliberately much smaller than the old all-or-nothing
	// consumeTimeout (6s): a normal browse returns a recent snapshot quickly and,
	// if some partitions are slow, returns the safely completed ones as a partial
	// page instead of failing the whole request.
	readBudget = 3 * time.Second
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
}

type consumeResult struct {
	rows      []map[string]any
	completed map[int32]bool
	timedOut  bool
	// partial reports that the read budget was exhausted before every scoped
	// partition finished, yet at least one partition completed with safe rows
	// that are returned to the caller. Task 2's fast snapshot reader sets this;
	// Task 3 surfaces it as DataResult.Meta["partial"]. The current reader never
	// sets it, which is why the partial-result unit tests fail red until Task 2.
	partial bool
}

// GetData reads one page of messages, newest first. Filters:
//   - partition: restrict to one partition (default: all)
//   - before_offsets: JSON map partition->offset from the previous page's
//     meta.next_before_offsets; fetches the window right below it.
func (c *KafkaConnector) GetData(ctx context.Context, topic string, opts connector.DataOpts) (*connector.DataResult, error) {
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

	metaCtx, cancelMeta := context.WithTimeout(ctx, metadataTimeout)
	defer cancelMeta()

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

	var (
		consumed        *consumeResult
		frontierWindows map[int32]partitionWindow
	)
	if scanning {
		// Content search reads a larger, evenly divided window per partition under
		// its own scan budget. This path is deliberately separate from the normal
		// browse quota so reader tuning never changes the scan budget.
		perPartition := dividedWindow(maxScanMessages, len(scoped))
		windows := make(map[int32]partitionWindow, len(scoped))
		for _, id := range scoped {
			start, end := partitionOffsets(topic, id, starts, ends)
			upper := end
			if before, ok := beforeOffsets[id]; ok && before < upper {
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
		consumed, err = resolveScanConsume(c.consumeWindows(ctx, topic, windows, maxScanMessages, scanTimeBudget))
		if err != nil {
			return nil, err
		}
		frontierWindows = windows
	} else {
		// Normal browse: bounded-quota fast snapshot with adaptive refill.
		consumed, frontierWindows, err = c.snapshotRead(ctx, topic, scoped, starts, ends, beforeOffsets, limit)
		if err != nil {
			return nil, err
		}
	}

	rows := consumed.rows
	if !scanning {
		rows = selectNewestPrefixes(rows, limit)
	}

	sortRowsNewest(rows)

	// Advance only partitions whose rows are actually returned to the caller.
	// Unread partitions keep their prior upper offset, so partial broker replies
	// never create pagination gaps.
	frontier := make(map[int32]int64, len(frontierWindows))
	for id, window := range frontierWindows {
		frontier[id] = window.upper
	}
	reached := lowestConsumedOffsets(rows)
	for id, off := range reached {
		if !scanning || consumed.completed[id] {
			frontier[id] = off
		}
	}

	nextBefore := make(map[string]int64)
	for id := range frontierWindows {
		start, _ := partitionOffsets(topic, id, starts, ends)
		if frontier[id] > start {
			nextBefore[strconv.Itoa(int(id))] = frontier[id]
		}
	}

	meta := map[string]any{
		"partitions": len(partitionIDs),
		"has_older":  len(nextBefore) > 0,
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
	}
	if len(nextBefore) > 0 {
		meta["next_before_offsets"] = nextBefore
	}

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
		HasMore: len(nextBefore) > 0,
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
		rows:      make([]map[string]any, 0, target),
		completed: make(map[int32]bool, len(windows)),
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
	for {
		fetches := c.consume.PollFetches(consumeCtx)
		if fetches.IsClientClosed() {
			return nil, fmt.Errorf("%w: kafka consumer closed while reading messages", connector.ErrUnavailable)
		}

		var fetchErr error
		for _, fetchError := range fetches.Errors() {
			if consumeCtx.Err() != nil {
				continue
			}
			fetchErr = fetchError.Err
			break
		}
		if fetchErr != nil {
			return nil, normalizeKafkaError(fetchErr)
		}

		fetches.EachRecord(func(record *kgo.Record) {
			window, ok := windows[record.Partition]
			if !ok || result.completed[record.Partition] || record.Offset < window.from {
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
	}

	completedCount := len(result.completed)
	if completedCount == len(windows) {
		// Every scoped partition finished its bounded range within budget.
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
			rows:      make([]map[string]any, 0),
			completed: make(map[int32]bool),
			timedOut:  true,
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
		rows:      make([]map[string]any, 0, limit),
		completed: make(map[int32]bool, len(frontierWindows)),
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
				aggregate.partial = true
				aggregate.timedOut = true
				return aggregate, frontierWindows, nil
			}
			return nil, nil, err
		}

		for id := range consumed.completed {
			aggregate.completed[id] = true
		}
		aggregate.rows = append(aggregate.rows, consumed.rows...)
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

// messageMatchesField reports whether a message contains the JSON path equal
// to want. Paths may start below the root ("events[].name"), and arrays are
// traversed implicitly, so both "events.name" and "events[].name" work.
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
	parts := normalizeJSONPath(field)
	if len(parts) == 0 {
		return false
	}
	return jsonPathMatchesAnywhere(parsed, parts, want)
}

func normalizeJSONPath(field string) []string {
	field = strings.TrimSpace(field)
	field = strings.TrimPrefix(field, "$")
	field = strings.TrimPrefix(field, ".")
	rawParts := strings.Split(field, ".")
	parts := make([]string, 0, len(rawParts))
	for _, part := range rawParts {
		part = strings.TrimSpace(part)
		part = strings.TrimSuffix(part, "[*]")
		part = strings.TrimSuffix(part, "[]")
		if part != "" {
			parts = append(parts, part)
		}
	}
	return parts
}

func jsonPathMatchesAnywhere(value any, parts []string, want string) bool {
	if jsonPathMatchesFrom(value, parts, want) {
		return true
	}
	switch typed := value.(type) {
	case map[string]any:
		for _, child := range typed {
			if jsonPathMatchesAnywhere(child, parts, want) {
				return true
			}
		}
	case []any:
		for _, child := range typed {
			if jsonPathMatchesAnywhere(child, parts, want) {
				return true
			}
		}
	}
	return false
}

func jsonPathMatchesFrom(value any, parts []string, want string) bool {
	if len(parts) == 0 {
		return jsonLeafEquals(value, want)
	}
	switch typed := value.(type) {
	case map[string]any:
		child, ok := typed[parts[0]]
		return ok && jsonPathMatchesFrom(child, parts[1:], want)
	case []any:
		for _, child := range typed {
			if jsonPathMatchesFrom(child, parts, want) {
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
