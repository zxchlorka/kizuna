package redis

import (
	"context"
	"encoding/json"
	"sort"
	"strings"
	"time"

	"github.com/qsnake66/infraview/internal/connector"
	goredis "github.com/redis/go-redis/v9"
)

func (c *RedisConnector) GetData(ctx context.Context, object string, opts connector.DataOpts) (*connector.DataResult, error) {
	opts = normalizeRedisOpts(opts)

	keyType, err := redisTypeOrNotFound(ctx, c, object)
	if err != nil {
		return nil, err
	}

	ttl, err := redisTTLSeconds(ctx, c, object)
	if err != nil {
		return nil, err
	}

	switch keyType {
	case "string":
		return c.getStringData(ctx, object, ttl, opts)
	case "hash":
		return c.getHashData(ctx, object, ttl, opts)
	case "list":
		return c.getListData(ctx, object, ttl, opts)
	case "set":
		return c.getSetData(ctx, object, ttl, opts)
	case "zset":
		return c.getZSetData(ctx, object, ttl, opts)
	case "stream":
		return c.getStreamData(ctx, object, ttl, opts)
	default:
		return nil, unsupportedRedisOperation("get data for " + keyType)
	}
}

func (c *RedisConnector) getStringData(ctx context.Context, key string, ttl int64, opts connector.DataOpts) (*connector.DataResult, error) {
	value, err := c.client.Get(ctx, key).Result()
	if err != nil {
		return nil, normalizeRedisError(err)
	}

	meta := redisMeta("string", ttl)
	var parsed any
	if json.Unmarshal([]byte(value), &parsed) == nil {
		meta["is_json"] = true
	}

	return redisDataResult(
		[]connector.ColumnMeta{{Name: "value", DataType: "text", Editable: true}},
		[]map[string]any{{"value": value}},
		1,
		meta,
		opts.Offset,
	), nil
}

func (c *RedisConnector) getHashData(ctx context.Context, key string, ttl int64, opts connector.DataOpts) (*connector.DataResult, error) {
	values, err := c.client.HGetAll(ctx, key).Result()
	if err != nil {
		return nil, normalizeRedisError(err)
	}

	fields := make([]string, 0, len(values))
	for field := range values {
		fields = append(fields, field)
	}
	sort.Strings(fields)

	start := minInt(opts.Offset, len(fields))
	end := minInt(start+opts.Limit, len(fields))
	rows := make([]map[string]any, 0, end-start)
	for _, field := range fields[start:end] {
		rows = append(rows, map[string]any{
			"field": field,
			"value": values[field],
		})
	}

	meta := redisMeta("hash", ttl)
	meta["length"] = len(fields)
	return redisDataResult(
		[]connector.ColumnMeta{
			{Name: "field", DataType: "text"},
			{Name: "value", DataType: "text", Editable: true},
		},
		rows,
		int64(len(fields)),
		meta,
		opts.Offset,
	), nil
}

func (c *RedisConnector) getListData(ctx context.Context, key string, ttl int64, opts connector.DataOpts) (*connector.DataResult, error) {
	total, err := c.client.LLen(ctx, key).Result()
	if err != nil {
		return nil, normalizeRedisError(err)
	}

	values, err := c.client.LRange(ctx, key, int64(opts.Offset), int64(opts.Offset+opts.Limit-1)).Result()
	if err != nil {
		return nil, normalizeRedisError(err)
	}

	rows := make([]map[string]any, 0, len(values))
	for index, value := range values {
		rows = append(rows, map[string]any{
			"index": opts.Offset + index,
			"value": value,
		})
	}

	meta := redisMeta("list", ttl)
	meta["length"] = total
	return redisDataResult(
		[]connector.ColumnMeta{
			{Name: "index", DataType: "integer"},
			{Name: "value", DataType: "text", Editable: true},
		},
		rows,
		total,
		meta,
		opts.Offset,
	), nil
}

func (c *RedisConnector) getSetData(ctx context.Context, key string, ttl int64, opts connector.DataOpts) (*connector.DataResult, error) {
	total, err := c.client.SCard(ctx, key).Result()
	if err != nil {
		return nil, normalizeRedisError(err)
	}

	members, err := c.scanSetMembers(ctx, key)
	if err != nil {
		return nil, err
	}
	sort.Strings(members)
	members = applyStringFilters(members, opts.Filters)

	start := minInt(opts.Offset, len(members))
	end := minInt(start+opts.Limit, len(members))
	rows := make([]map[string]any, 0, end-start)
	for _, member := range members[start:end] {
		rows = append(rows, map[string]any{"member": member})
	}

	meta := redisMeta("set", ttl)
	meta["length"] = total
	return redisDataResult(
		[]connector.ColumnMeta{{Name: "member", DataType: "text", Editable: true}},
		rows,
		int64(len(members)),
		meta,
		opts.Offset,
	), nil
}

func (c *RedisConnector) getZSetData(ctx context.Context, key string, ttl int64, opts connector.DataOpts) (*connector.DataResult, error) {
	total, err := c.client.ZCard(ctx, key).Result()
	if err != nil {
		return nil, normalizeRedisError(err)
	}

	var values []goredis.Z
	if opts.OrderDir == "desc" {
		values, err = c.client.ZRevRangeWithScores(ctx, key, int64(opts.Offset), int64(opts.Offset+opts.Limit-1)).Result()
	} else {
		values, err = c.client.ZRangeWithScores(ctx, key, int64(opts.Offset), int64(opts.Offset+opts.Limit-1)).Result()
	}
	if err != nil {
		return nil, normalizeRedisError(err)
	}

	rows := make([]map[string]any, 0, len(values))
	for _, value := range values {
		rows = append(rows, map[string]any{
			"score":  value.Score,
			"member": value.Member,
		})
	}

	if strings.EqualFold(opts.OrderBy, "member") {
		sort.SliceStable(rows, func(i, j int) bool {
			left := redisStringValue(rows[i]["member"])
			right := redisStringValue(rows[j]["member"])
			if opts.OrderDir == "desc" {
				return left > right
			}
			return left < right
		})
	}

	meta := redisMeta("zset", ttl)
	meta["length"] = total
	return redisDataResult(
		[]connector.ColumnMeta{
			{Name: "score", DataType: "float", Editable: true},
			{Name: "member", DataType: "text"},
		},
		rows,
		total,
		meta,
		opts.Offset,
	), nil
}

func (c *RedisConnector) getStreamData(ctx context.Context, key string, ttl int64, opts connector.DataOpts) (*connector.DataResult, error) {
	total, err := c.client.XLen(ctx, key).Result()
	if err != nil {
		return nil, normalizeRedisError(err)
	}

	values, err := c.client.XRangeN(ctx, key, "-", "+", int64(opts.Offset+opts.Limit)).Result()
	if err != nil {
		return nil, normalizeRedisError(err)
	}

	start := minInt(opts.Offset, len(values))
	entries := values[start:]
	if len(entries) > opts.Limit {
		entries = entries[:opts.Limit]
	}

	fieldSet := make(map[string]struct{})
	for _, entry := range entries {
		for field := range entry.Values {
			fieldSet[field] = struct{}{}
		}
	}
	fields := make([]string, 0, len(fieldSet))
	for field := range fieldSet {
		fields = append(fields, field)
	}
	sort.Strings(fields)

	columns := []connector.ColumnMeta{
		{Name: "id", DataType: "text"},
		{Name: "timestamp", DataType: "timestamp"},
	}
	for _, field := range fields {
		columns = append(columns, connector.ColumnMeta{Name: field, DataType: "text"})
	}

	rows := make([]map[string]any, 0, len(entries))
	for _, entry := range entries {
		row := map[string]any{
			"id":        entry.ID,
			"timestamp": streamTimestampFromID(entry.ID).Format(time.RFC3339),
		}
		for _, field := range fields {
			row[field] = entry.Values[field]
		}
		rows = append(rows, row)
	}

	meta := redisMeta("stream", ttl)
	meta["length"] = total
	return redisDataResult(columns, rows, total, meta, opts.Offset), nil
}

func (c *RedisConnector) scanSetMembers(ctx context.Context, key string) ([]string, error) {
	members := make([]string, 0, 128)
	var cursor uint64
	for {
		batch, nextCursor, err := c.client.SScan(ctx, key, cursor, "", 1000).Result()
		if err != nil {
			return nil, normalizeRedisError(err)
		}
		members = append(members, batch...)
		cursor = nextCursor
		if cursor == 0 || len(members) >= maxScanKeys {
			break
		}
	}
	return members, nil
}

func applyStringFilters(values []string, filters []connector.FilterExpr) []string {
	if len(filters) == 0 {
		return values
	}

	filtered := make([]string, 0, len(values))
	for _, value := range values {
		if matchesStringFilters(value, filters) {
			filtered = append(filtered, value)
		}
	}
	return filtered
}

func matchesStringFilters(value string, filters []connector.FilterExpr) bool {
	lower := strings.ToLower(value)
	for _, filter := range filters {
		needle := strings.ToLower(strings.TrimSpace(filter.Value))
		switch filter.Op {
		case "contains", "like":
			if needle != "" && !strings.Contains(lower, needle) {
				return false
			}
		case "eq":
			if value != filter.Value {
				return false
			}
		case "neq":
			if value == filter.Value {
				return false
			}
		}
	}
	return true
}

func minInt(left, right int) int {
	if left < right {
		return left
	}
	return right
}
