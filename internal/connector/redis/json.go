package redis

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"strings"

	"github.com/zxchlorka/kizuna/internal/connector"
)

func (c *RedisConnector) getJSONData(ctx context.Context, key string, ttl int64, opts connector.DataOpts) (*connector.DataResult, error) {
	raw, err := c.client.Do(ctx, "JSON.GET", key, "$").Text()
	if err != nil {
		return nil, normalizeRedisError(err)
	}

	var value any
	if err := json.Unmarshal([]byte(raw), &value); err != nil {
		return nil, fmt.Errorf("%w: invalid JSON payload stored in %q", connector.ErrBadRequest, key)
	}
	if rootArray, ok := value.([]any); ok && len(rootArray) == 1 {
		value = rootArray[0]
	}

	rows := make([]map[string]any, 0, 32)
	flattenJSONRows(&rows, "$", "", value, 0)

	meta := redisMeta("json", ttl)
	meta["length"] = len(rows)
	meta["root_path"] = "$"

	return redisDataResult(
		[]connector.ColumnMeta{
			{Name: "path", DataType: "text"},
			{Name: "value", DataType: "json", Editable: true},
			{Name: "type", DataType: "text"},
			{Name: "depth", DataType: "integer"},
			{Name: "parent_path", DataType: "text"},
		},
		rows,
		int64(len(rows)),
		meta,
		opts.Offset,
	), nil
}

func flattenJSONRows(rows *[]map[string]any, path, parentPath string, value any, depth int) {
	rowType, leaf := jsonValueType(value)
	row := map[string]any{
		"path":        path,
		"type":        rowType,
		"depth":       depth,
		"parent_path": parentPath,
		"is_leaf":     leaf,
	}
	if leaf {
		row["value"] = value
	} else {
		row["value"] = nil
	}
	*rows = append(*rows, row)

	switch typed := value.(type) {
	case map[string]any:
		keys := make([]string, 0, len(typed))
		for key := range typed {
			keys = append(keys, key)
		}
		sortStrings(keys)
		for _, key := range keys {
			childPath := buildRedisJSONChildPath(path, key)
			flattenJSONRows(rows, childPath, path, typed[key], depth+1)
		}
	case []any:
		for index, item := range typed {
			childPath := fmt.Sprintf("%s[%d]", path, index)
			flattenJSONRows(rows, childPath, path, item, depth+1)
		}
	}
}

func jsonValueType(value any) (string, bool) {
	switch value.(type) {
	case nil:
		return "null", true
	case string:
		return "string", true
	case bool:
		return "boolean", true
	case float32, float64, int, int8, int16, int32, int64, uint, uint8, uint16, uint32, uint64, json.Number:
		return "number", true
	case []any:
		return "array", false
	case map[string]any:
		return "object", false
	default:
		return "unknown", true
	}
}

func buildRedisJSONChildPath(path, segment string) string {
	if isRedisJSONDotSegment(segment) {
		return path + "." + segment
	}

	encoded, err := json.Marshal(segment)
	if err != nil {
		return path + `[""]`
	}
	return path + "[" + string(encoded) + "]"
}

func isRedisJSONDotSegment(segment string) bool {
	if segment == "" {
		return false
	}

	for index, r := range segment {
		if index == 0 {
			if !(r == '_' || r == '$' || r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z') {
				return false
			}
			continue
		}

		if !(r == '_' || r == '$' || r >= '0' && r <= '9' || r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z') {
			return false
		}
	}

	return true
}

func (c *RedisConnector) updateJSONPath(ctx context.Context, key string, op connector.MutateOp) (int64, error) {
	path := strings.TrimSpace(redisStringValue(op.Where["path"]))
	if path == "" {
		path = strings.TrimSpace(redisStringValue(op.Data["path"]))
	}
	if path == "" {
		return 0, fmt.Errorf("%w: json path is required", connector.ErrBadRequest)
	}

	value, ok := op.Data["value"]
	if !ok {
		return 0, fmt.Errorf("%w: json value is required", connector.ErrBadRequest)
	}

	encoded, err := redisEncodeJSONValue(value)
	if err != nil {
		return 0, err
	}

	if err := c.client.Do(ctx, "JSON.SET", key, path, encoded).Err(); err != nil {
		return 0, normalizeRedisError(err)
	}
	return 1, nil
}

func sortStrings(values []string) {
	if len(values) < 2 {
		return
	}
	sort.Slice(values, func(i, j int) bool {
		return values[i] < values[j]
	})
}
