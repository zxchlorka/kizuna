package redis

import (
	"context"
	"fmt"

	"github.com/zxchlorka/kizuna/internal/connector"
)

func (c *RedisConnector) GetObjectInfo(ctx context.Context, object string) (*connector.ObjectInfo, error) {
	keyMeta, err := c.getKeyMeta(ctx, object)
	if err != nil {
		return nil, err
	}

	schema, err := c.GetSchema(ctx, object)
	if err != nil {
		return nil, err
	}

	return &connector.ObjectInfo{
		Name:       object,
		Schema:     "",
		ObjectType: redisObjectTypeName(keyMeta.keyType),
		Columns:    columnNames(schema.Columns),
		Definition: fmt.Sprintf("Redis %s key %q (ttl=%d)", keyMeta.keyType, object, keyMeta.ttl),
	}, nil
}

func (c *RedisConnector) GetSchema(ctx context.Context, object string) (*connector.Schema, error) {
	keyMeta, err := c.getKeyMeta(ctx, object)
	if err != nil {
		return nil, err
	}
	keyType := keyMeta.keyType
	ttl := keyMeta.ttl

	meta := redisMeta(keyType, ttl)

	// What this one key costs in RAM, sampled rather than walked: MEMORY USAGE
	// visits a bounded number of elements on a large collection instead of every
	// one. A key that cannot be measured is reported without the figure rather
	// than failing the whole schema read.
	// Through the typed method, not Do: a raw command carries no key position, so
	// a cluster client cannot tell which node owns the key and asks the wrong one.
	if bytes, ok := c.keyMemoryUsage(ctx, object); ok {
		meta["memory_bytes"] = bytes
	}
	var columns []connector.ColumnMeta

	switch keyType {
	case "string":
		columns = []connector.ColumnMeta{
			{Name: "value", DataType: "text", Editable: true},
		}
	case "hash":
		length, err := c.keyLength(ctx, object, keyType, ttl)
		if err != nil {
			return nil, err
		}
		meta["length"] = length
		columns = []connector.ColumnMeta{
			{Name: "field", DataType: "text"},
			{Name: "value", DataType: "text", Editable: true},
		}
	case "list":
		length, err := c.keyLength(ctx, object, keyType, ttl)
		if err != nil {
			return nil, err
		}
		meta["length"] = length
		columns = []connector.ColumnMeta{
			{Name: "index", DataType: "integer"},
			{Name: "value", DataType: "text", Editable: true},
		}
	case "set":
		length, err := c.keyLength(ctx, object, keyType, ttl)
		if err != nil {
			return nil, err
		}
		meta["length"] = length
		columns = []connector.ColumnMeta{
			{Name: "member", DataType: "text", Editable: true},
		}
	case "zset":
		length, err := c.keyLength(ctx, object, keyType, ttl)
		if err != nil {
			return nil, err
		}
		meta["length"] = length
		columns = []connector.ColumnMeta{
			{Name: "score", DataType: "float", Editable: true},
			{Name: "member", DataType: "text"},
		}
	case "stream":
		length, err := c.keyLength(ctx, object, keyType, ttl)
		if err != nil {
			return nil, err
		}
		meta["length"] = length
		columns = []connector.ColumnMeta{
			{Name: "id", DataType: "text"},
			{Name: "timestamp", DataType: "timestamp"},
		}
	case "json":
		meta["is_json_module"] = true
		columns = []connector.ColumnMeta{
			{Name: "path", DataType: "text"},
			{Name: "value", DataType: "json", Editable: true},
			{Name: "type", DataType: "text"},
			{Name: "depth", DataType: "integer"},
			{Name: "parent_path", DataType: "text"},
		}
	default:
		return nil, fmt.Errorf("%w: unsupported redis type %q", connector.ErrBadRequest, keyType)
	}

	return &connector.Schema{
		ObjectType: redisObjectTypeName(keyType),
		Columns:    columns,
		Meta:       meta,
	}, nil
}

func (c *RedisConnector) keyLength(ctx context.Context, key string, keyType string, ttl int64) (int64, error) {
	if meta, ok := c.cachedKeyMeta(key, true); ok && meta.keyType == keyType {
		return *meta.length, nil
	}

	var (
		length int64
		err    error
	)
	switch keyType {
	case "hash":
		length, err = c.client.HLen(ctx, key).Result()
	case "list":
		length, err = c.client.LLen(ctx, key).Result()
	case "set":
		length, err = c.client.SCard(ctx, key).Result()
	case "zset":
		length, err = c.client.ZCard(ctx, key).Result()
	case "stream":
		length, err = c.client.XLen(ctx, key).Result()
	default:
		return 0, nil
	}
	if err != nil {
		return 0, normalizeRedisError(err)
	}
	c.rememberKeyLength(key, keyType, ttl, length)
	return length, nil
}

func columnNames(columns []connector.ColumnMeta) []string {
	names := make([]string, 0, len(columns))
	for _, column := range columns {
		names = append(names, column.Name)
	}
	return names
}

// keyMemoryUsage reports what one key costs in RAM, sampled by Redis rather than
// walked on a large collection. Reported through the typed method, not Do: a raw
// command carries no key position, so a cluster client cannot tell which node
// owns the key and asks the wrong one.
func (c *RedisConnector) keyMemoryUsage(ctx context.Context, key string) (int64, bool) {
	sizer, ok := c.client.(redisMemoryUsager)
	if !ok {
		return 0, false
	}
	bytes, err := sizer.MemoryUsage(ctx, key).Result()
	if err != nil {
		return 0, false
	}
	return bytes, true
}
