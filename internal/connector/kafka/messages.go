package kafka

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/qsnake66/infraview/internal/connector"
	"github.com/twmb/franz-go/pkg/kadm"
	"github.com/twmb/franz-go/pkg/kgo"
)

const (
	defaultMessageLimit = 50
	maxMessageLimit     = 500
	consumeTimeout      = 4 * time.Second
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

	perPartition := int64(limit)
	if len(scoped) > 1 {
		perPartition = int64((limit + len(scoped) - 1) / len(scoped))
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

	rows, err := c.consumeWindows(ctx, topic, windows)
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

	nextBefore := make(map[string]int64)
	for id, window := range windows {
		start, _ := partitionOffsets(topic, id, starts, ends)
		if window.from > start {
			nextBefore[strconv.Itoa(int(id))] = window.from
		}
	}

	meta := map[string]any{
		"partitions": len(partitionIDs),
		"has_older":  len(nextBefore) > 0,
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
func (c *KafkaConnector) consumeWindows(ctx context.Context, topic string, windows map[int32]partitionWindow) ([]map[string]any, error) {
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

	consumeCtx, cancel := context.WithTimeout(ctx, consumeTimeout)
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
