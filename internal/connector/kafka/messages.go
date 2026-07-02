package kafka

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/qsnake66/kizuna/internal/connector"
	"github.com/twmb/franz-go/pkg/kadm"
	"github.com/twmb/franz-go/pkg/kgo"
)

const (
	defaultMessageLimit = 50
	maxMessageLimit     = 500
	consumeTimeout      = 4 * time.Second

	// Content-search scan budget for one "Scan more" step. A single step
	// examines at most maxScanMessages records (across scoped partitions) within
	// scanTimeBudget, then returns matches plus a cursor to continue deeper.
	maxScanMessages = 5000
	scanTimeBudget  = 8 * time.Second
)

type partitionWindow struct {
	from  int64
	upper int64 // exclusive
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

	starts, err := c.admin.ListStartOffsets(metaCtx, topic)
	if err != nil {
		return nil, normalizeKafkaError(err)
	}
	ends, err := c.admin.ListEndOffsets(metaCtx, topic)
	if err != nil {
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

	// In scan mode the window is sized by the scan budget (not the page limit):
	// we examine a large slice and filter it down to matches.
	budget := limit
	if scanning {
		budget = maxScanMessages
	}
	perPartition := int64(budget)
	if len(scoped) > 1 {
		perPartition = int64((budget + len(scoped) - 1) / len(scoped))
	}

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

	timeout := consumeTimeout
	if scanning {
		timeout = scanTimeBudget
	}
	rows, err := c.consumeWindows(ctx, topic, windows, timeout)
	if err != nil {
		return nil, err
	}

	sort.SliceStable(rows, func(i, j int) bool {
		left, _ := rows[i]["timestamp"].(string)
		right, _ := rows[j]["timestamp"].(string)
		if left == right {
			lo, _ := rows[i]["offset"].(int64)
			ro, _ := rows[j]["offset"].(int64)
			return lo > ro
		}
		return left > right
	})

	// Advance the cursor by how far we actually consumed. In scan mode a large
	// window may not be fully drained within the time budget, so using the
	// lowest consumed offset (instead of the requested window floor) guarantees
	// "Scan more" never skips unread messages.
	frontier := make(map[int32]int64, len(windows))
	for id, window := range windows {
		frontier[id] = window.from
	}
	if scanning {
		reached := lowestConsumedOffsets(rows)
		for id, window := range windows {
			if off, ok := reached[id]; ok {
				frontier[id] = off
			} else {
				frontier[id] = window.upper // consumed nothing: no progress
			}
		}
	}

	nextBefore := make(map[string]int64)
	for id := range windows {
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
		rows = filterMatches(rows, matchField, matchValue)
		meta["matched"] = len(rows)
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

// consumeWindows reads the requested offset windows with a dedicated
// short-lived consumer client, so the shared admin client never carries
// consume state. Only the requested offsets are fetched — never the topic.
func (c *KafkaConnector) consumeWindows(ctx context.Context, topic string, windows map[int32]partitionWindow, timeout time.Duration) ([]map[string]any, error) {
	rows := make([]map[string]any, 0, 64)
	if len(windows) == 0 {
		return rows, nil
	}

	offsets := make(map[int32]kgo.Offset, len(windows))
	var needed int64
	for id, window := range windows {
		offsets[id] = kgo.NewOffset().At(window.from)
		needed += window.upper - window.from
	}

	opts, err := buildClientOpts(c.settings)
	if err != nil {
		return nil, err
	}
	opts = append(opts, kgo.ConsumePartitions(map[string]map[int32]kgo.Offset{topic: offsets}))

	client, err := kgo.NewClient(opts...)
	if err != nil {
		return nil, fmt.Errorf("failed to create kafka consumer: %w", err)
	}
	defer client.Close()

	consumeCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	collected := int64(0)
	for collected < needed {
		fetches := client.PollFetches(consumeCtx)
		if fetches.IsClientClosed() {
			break
		}

		var fetchErr error
		for _, err := range fetches.Errors() {
			if consumeCtx.Err() != nil {
				continue
			}
			fetchErr = err.Err
			break
		}
		if fetchErr != nil {
			return nil, normalizeKafkaError(fetchErr)
		}

		fetches.EachRecord(func(record *kgo.Record) {
			window, ok := windows[record.Partition]
			if !ok || record.Offset < window.from || record.Offset >= window.upper {
				return
			}
			rows = append(rows, recordRow(record))
			collected++
		})

		if consumeCtx.Err() != nil {
			break
		}
	}

	return rows, nil
}

func recordRow(record *kgo.Record) map[string]any {
	key, _ := deserializePayload(record.Key)
	value, format := deserializePayload(record.Value)

	row := map[string]any{
		"partition": record.Partition,
		"offset":    record.Offset,
		"timestamp": record.Timestamp.UTC().Format(time.RFC3339Nano),
		"key":       key,
		"value":     value,
		"format":    format,
	}
	if headers := recordHeaders(record); headers != nil {
		row["headers"] = headers
	}
	return row
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

// messageMatchesField reports whether a message's JSON value has the field
// (a "." path is followed into nested objects) equal to want. Non-JSON values
// and missing paths never match.
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
	leaf, ok := navigateJSONPath(parsed, strings.Split(field, "."))
	if !ok {
		return false
	}
	return jsonLeafEquals(leaf, want)
}

func navigateJSONPath(value any, parts []string) (any, bool) {
	current := value
	for _, part := range parts {
		object, ok := current.(map[string]any)
		if !ok {
			return nil, false
		}
		current, ok = object[part]
		if !ok {
			return nil, false
		}
	}
	return current, true
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
