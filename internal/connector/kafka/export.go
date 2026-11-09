package kafka

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"strconv"

	"github.com/twmb/franz-go/pkg/kadm"
	"github.com/twmb/franz-go/pkg/kerr"
	"github.com/twmb/franz-go/pkg/kgo"
	"github.com/zxchlorka/kizuna/internal/connector"
	"golang.org/x/sync/errgroup"
)

// ExportFields streams the chosen fields of every message in the range the
// browse toolbar describes: the partition filter, the seek and its direction,
// and the content filters, read up to the end offsets as they stand when the
// call starts. Messages produced after that are left out, so an export of a
// live topic finishes.
//
// Everything that can be rejected is rejected before the first emit, so the
// caller can still answer with a plain error. After that the only failures are
// the broker's, a cancelled ctx, or emit's own.
func (c *KafkaConnector) ExportFields(
	ctx context.Context,
	topic string,
	fields []string,
	filters []connector.FilterExpr,
	emit func(cells []string) error,
) error {
	columns, err := parseExportFields(fields)
	if err != nil {
		return err
	}
	partitionFilter, err := parsePartitionFilter(filters)
	if err != nil {
		return err
	}
	direction, err := parseDirection(filters)
	if err != nil {
		return err
	}
	seek, err := parseSeek(filters)
	if err != nil {
		return err
	}
	matchQ := parseMatchQuery(filters)

	metaCtx, cancelMeta := context.WithTimeout(ctx, metadataTimeout)
	starts, ends, err := c.listOffsetBounds(metaCtx, topic)
	cancelMeta()
	if err != nil {
		return err
	}
	endsByPartition, ok := ends[topic]
	if !ok || len(endsByPartition) == 0 || partitionsAllErrored(endsByPartition) {
		return fmt.Errorf("%w: topic %q not found", connector.ErrRelationNotFound, topic)
	}
	scoped := make([]int32, 0, len(endsByPartition))
	for _, id := range sortedPartitionIDs(endsByPartition) {
		if partitionFilter < 0 || id == partitionFilter {
			scoped = append(scoped, id)
		}
	}
	if len(scoped) == 0 {
		return fmt.Errorf("%w: partition %d not found in topic %q", connector.ErrBadRequest, partitionFilter, topic)
	}
	seekBounds, err := c.resolveSeekBounds(ctx, topic, seek, direction, scoped)
	if err != nil {
		return err
	}
	windows := exportWindows(scoped, func(id int32) (int64, int64) {
		return partitionOffsets(topic, id, starts, ends)
	}, seekBounds, direction)
	if len(windows) == 0 {
		return nil
	}

	// A client of its own: the shared one serialises every browse of this
	// connection behind consumeMu, and an export holding it for minutes would
	// freeze them all. No consumer group, so nothing is committed anywhere.
	offsets := make(map[int32]kgo.Offset, len(windows))
	for id, window := range windows {
		offsets[id] = kgo.NewOffset().At(window.from)
	}
	opts, err := buildClientOpts(c.settings)
	if err != nil {
		return err
	}
	opts = append(opts,
		kgo.ConsumePartitions(map[string]map[int32]kgo.Offset{topic: offsets}),
		// Retention can delete the start of a partition while a long export is
		// still on its way there; carry on from whatever is left.
		kgo.ConsumeResetOffset(kgo.NewOffset().AtStart()),
		// Aborted transactions never happened as far as any consumer of the data
		// is concerned. It also caps a fetch at the last stable offset, which the
		// empty-fetch rule below treats as the end.
		kgo.FetchIsolationLevel(kgo.ReadCommitted()),
		// Transaction markers occupy offsets, often the very last one. Kept so
		// the end of a partition is seen as a record rather than inferred from an
		// empty fetch; they are never written to the file.
		kgo.KeepControlRecords(),
		kgo.FetchMaxWait(fetchMaxWait),
	)
	client, err := kgo.NewClient(opts...)
	if err != nil {
		return fmt.Errorf("failed to create kafka export client: %w", err)
	}
	defer client.Close()

	done := make(map[int32]bool, len(windows))
	for len(done) < len(windows) {
		fetches := client.PollFetches(ctx)
		if err := ctx.Err(); err != nil {
			return err
		}
		for _, fetchError := range fetches.Errors() {
			// franz-go retries these itself; a non-retriable one is final.
			if !kerr.IsRetriable(fetchError.Err) {
				return normalizeKafkaError(fetchError.Err)
			}
		}

		finished := make([]int32, 0, len(windows))
		var emitErr error
		fetches.EachPartition(func(partition kgo.FetchTopicPartition) {
			window, ok := windows[partition.Partition]
			if emitErr != nil || partition.Topic != topic || !ok || done[partition.Partition] {
				return
			}
			for _, record := range partition.Records {
				if record.Offset >= window.upper {
					break
				}
				if record.Offset < window.from || record.Attrs.IsControl() {
					continue
				}
				if matchQ.active() && !messageMatchesQuery(finalizeRow(rawCandidateRow(record)), matchQ) {
					continue
				}
				if cells, found := extractExportCells(record.Value, columns); found {
					if emitErr = emit(cells); emitErr != nil {
						return
					}
				}
			}
			// The same rule as consumeWindows: the last offset may never arrive
			// (compaction, transaction markers), so an empty fetch at or past the
			// end also finishes the partition.
			reached := len(partition.Records) > 0 && partition.Records[len(partition.Records)-1].Offset >= window.upper-1
			if reached || (len(partition.Records) == 0 && partition.HighWatermark >= window.upper) {
				done[partition.Partition] = true
				finished = append(finished, partition.Partition)
			}
		})
		if emitErr != nil {
			return emitErr
		}
		if len(finished) > 0 {
			client.PauseFetchPartitions(map[string][]int32{topic: finished})
		}
	}
	return nil
}

// exportWindows turns the partitions in scope into the offset range each one
// contributes. The seek bound means what it means for the browse: with newest
// first it is an exclusive ceiling (the toolbar shows that point and older),
// with oldest first an inclusive floor (that point and newer). Partitions with
// nothing in range are left out.
func exportWindows(
	scoped []int32,
	bounds func(id int32) (start, end int64),
	seekBounds map[int32]int64,
	direction readDirection,
) map[int32]partitionWindow {
	windows := make(map[int32]partitionWindow, len(scoped))
	for _, id := range scoped {
		start, end := bounds(id)
		window := partitionWindow{from: start, upper: end}
		if bound, ok := seekBounds[id]; ok {
			if direction.oldestFirst() {
				window.from = max(start, bound)
			} else {
				window.upper = min(end, bound)
			}
		}
		if window.from < window.upper {
			windows[id] = window
		}
	}
	return windows
}

// listOffsetBounds lists the topic's start and end offsets in parallel.
func (c *KafkaConnector) listOffsetBounds(ctx context.Context, topic string) (kadm.ListedOffsets, kadm.ListedOffsets, error) {
	var starts, ends kadm.ListedOffsets
	group, groupCtx := errgroup.WithContext(ctx)
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
		return nil, nil, normalizeKafkaError(err)
	}
	return starts, ends, nil
}

// exportField is one column of a field export: a parsed canonical path and
// whether it fans out over an array ('[]' anywhere in it). A fanned-out field is
// always written as a JSON array, even with a single element, so a column never
// changes shape from one row to the next.
type exportField struct {
	path   []jsonPathSegment
	fanOut bool
}

func parseExportFields(fields []string) ([]exportField, error) {
	if len(fields) == 0 {
		return nil, fmt.Errorf("%w: at least one field is required", connector.ErrBadRequest)
	}
	parsed := make([]exportField, 0, len(fields))
	for _, field := range fields {
		path := parseJSONPath(field)
		if len(path) == 0 {
			return nil, fmt.Errorf("%w: invalid field path %q", connector.ErrBadRequest, field)
		}
		field := exportField{path: path}
		for _, segment := range path {
			if segment.kind == jsonPathIndex {
				field.fanOut = true
				break
			}
		}
		parsed = append(parsed, field)
	}
	return parsed, nil
}

// extractExportCells renders one message as a CSV row. found is false when none
// of the fields is present (or the value is not a JSON document at all), which
// is the caller's cue to leave the message out of the file.
//
// Paths resolve strictly from the root, unlike the search matcher which retries
// a path at every depth: a search asks "is it anywhere", an export column has to
// name exactly one place, or one row's user_id would come from somewhere else
// than the next row's.
func extractExportCells(value []byte, fields []exportField) ([]string, bool) {
	cells := make([]string, len(fields))
	// UseNumber so an int64 id keeps its digits; as float64 it would read back as
	// a different id.
	decoder := json.NewDecoder(bytes.NewReader(value))
	decoder.UseNumber()
	var document any
	if decoder.Decode(&document) != nil {
		return cells, false
	}
	if _, err := decoder.Token(); err != io.EOF {
		return cells, false
	}

	found := false
	for i, field := range fields {
		values := resolveExportPath(document, field.path, nil)
		if len(values) == 0 {
			continue
		}
		found = true
		if field.fanOut {
			cells[i] = exportJSON(values)
		} else {
			cells[i] = exportCell(values[0])
		}
	}
	return cells, found
}

// resolveExportPath appends every value the path reaches. A key segment
// descends objects only and '[]' descends arrays only, so without '[]' it
// yields at most one value.
func resolveExportPath(value any, path []jsonPathSegment, acc []any) []any {
	if len(path) == 0 {
		return append(acc, value)
	}
	segment := path[0]
	switch typed := value.(type) {
	case map[string]any:
		if segment.kind == jsonPathKey {
			if child, ok := typed[segment.key]; ok {
				return resolveExportPath(child, path[1:], acc)
			}
		}
	case []any:
		if segment.kind == jsonPathIndex {
			for _, child := range typed {
				acc = resolveExportPath(child, path[1:], acc)
			}
		}
	}
	return acc
}

func exportCell(value any) string {
	switch typed := value.(type) {
	case nil:
		return ""
	case string:
		return typed
	case json.Number:
		return typed.String()
	case bool:
		return strconv.FormatBool(typed)
	default:
		return exportJSON(typed)
	}
}

// exportJSON writes objects and arrays compactly. HTML escaping is off: the
// cell is data for a spreadsheet or a script, and "<" there is just noise.
func exportJSON(value any) string {
	var buf bytes.Buffer
	encoder := json.NewEncoder(&buf)
	encoder.SetEscapeHTML(false)
	// Encoding a decoded JSON value cannot fail.
	_ = encoder.Encode(value)
	return string(bytes.TrimRight(buf.Bytes(), "\n"))
}
