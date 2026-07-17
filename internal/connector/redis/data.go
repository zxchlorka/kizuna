package redis

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"strings"
	"time"

	goredis "github.com/redis/go-redis/v9"
	"github.com/zxchlorka/kizuna/internal/connector"
)

func (c *RedisConnector) GetData(ctx context.Context, object string, opts connector.DataOpts) (*connector.DataResult, error) {
	opts = normalizeRedisOpts(opts)

	keyMeta, err := c.getKeyMeta(ctx, object)
	if err != nil {
		return nil, err
	}
	keyType := keyMeta.keyType
	ttl := keyMeta.ttl

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
	case "json":
		return c.getJSONData(ctx, object, ttl, opts)
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
	total, err := c.client.HLen(ctx, key).Result()
	if err != nil {
		return nil, normalizeRedisError(err)
	}
	c.rememberKeyLength(key, "hash", ttl, total)

	// HSCAN with a cap instead of HGETALL: a multi-million-field hash must not
	// be shipped (and held in memory) wholesale.
	match := redisContainsPattern(opts.Filters, "field")
	values, truncated, err := c.scanHashFields(ctx, key, match)
	if err != nil {
		return nil, err
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
	meta["length"] = total
	if truncated {
		meta["truncated"] = true
	}
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

func (c *RedisConnector) scanHashFields(ctx context.Context, key, match string) (map[string]string, bool, error) {
	values := make(map[string]string)
	var cursor uint64
	deadline := time.Now().Add(pageTimeBudget)

	for {
		batch, next, err := c.client.HScan(ctx, key, cursor, match, scanBatchCount).Result()
		if err != nil {
			return nil, false, normalizeRedisError(err)
		}
		for i := 0; i+1 < len(batch); i += 2 {
			values[batch[i]] = batch[i+1]
		}

		cursor = next
		if cursor == 0 {
			return values, false, nil
		}
		if len(values) >= maxScanKeys || time.Now().After(deadline) {
			return values, true, nil
		}
	}
}

func (c *RedisConnector) getListData(ctx context.Context, key string, ttl int64, opts connector.DataOpts) (*connector.DataResult, error) {
	total, err := c.client.LLen(ctx, key).Result()
	if err != nil {
		return nil, normalizeRedisError(err)
	}
	c.rememberKeyLength(key, "list", ttl, total)

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
	c.rememberKeyLength(key, "set", ttl, total)

	match := redisContainsPattern(opts.Filters, "member")
	members, truncated, err := c.scanSetMembers(ctx, key, match)
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
	if truncated {
		meta["truncated"] = true
	}
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
	c.rememberKeyLength(key, "zset", ttl, total)

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
	c.rememberKeyLength(key, "stream", ttl, total)

	afterID := redisFilterValue(opts.Filters, "after_id")
	beforeID := redisFilterValue(opts.Filters, "before_id")
	if afterID != "" && beforeID != "" {
		return nil, fmt.Errorf("%w: after_id and before_id cannot be combined", connector.ErrBadRequest)
	}

	var entries []goredis.XMessage
	var hasOlder bool
	var hasNewer bool
	fetchLimit := int64(opts.Limit + 1)
	switch {
	case afterID != "":
		entries, err = c.client.XRangeN(ctx, key, "("+afterID, "+", fetchLimit).Result()
		entries, hasNewer = trimStreamEntries(entries, opts.Limit)
		hasOlder = len(entries) > 0
	case beforeID != "":
		entries, err = c.client.XRevRangeN(ctx, key, "("+beforeID, "-", fetchLimit).Result()
		entries, hasOlder = trimStreamEntries(entries, opts.Limit)
		reverseXMessages(entries)
		hasNewer = len(entries) > 0
	default:
		entries, err = c.client.XRevRangeN(ctx, key, "+", "-", fetchLimit).Result()
		entries, hasOlder = trimStreamEntries(entries, opts.Limit)
		reverseXMessages(entries)
	}
	if err != nil {
		return nil, normalizeRedisError(err)
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
	meta["consumer_groups"] = 0
	groups, err := c.client.XInfoGroups(ctx, key).Result()
	if err == nil {
		meta["consumer_groups"] = len(groups)
	}
	if len(entries) > 0 {
		meta["first_id"] = entries[0].ID
		meta["last_id"] = entries[len(entries)-1].ID
		meta["has_older"] = hasOlder
		meta["has_newer"] = hasNewer
	}
	return redisDataResult(columns, rows, total, meta, opts.Offset), nil
}

func trimStreamEntries(entries []goredis.XMessage, limit int) ([]goredis.XMessage, bool) {
	if len(entries) <= limit {
		return entries, false
	}
	return entries[:limit], true
}

func reverseXMessages(values []goredis.XMessage) {
	for left, right := 0, len(values)-1; left < right; left, right = left+1, right-1 {
		values[left], values[right] = values[right], values[left]
	}
}

func (c *RedisConnector) scanSetMembers(ctx context.Context, key, match string) ([]string, bool, error) {
	members := make([]string, 0, 128)
	var cursor uint64
	deadline := time.Now().Add(pageTimeBudget)

	for {
		batch, nextCursor, err := c.client.SScan(ctx, key, cursor, match, scanBatchCount).Result()
		if err != nil {
			return nil, false, normalizeRedisError(err)
		}
		members = append(members, batch...)

		cursor = nextCursor
		if cursor == 0 {
			return members, false, nil
		}
		if len(members) >= maxScanKeys || time.Now().After(deadline) {
			return members, true, nil
		}
	}
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
