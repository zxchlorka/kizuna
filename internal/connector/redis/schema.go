package redis

import (
	"context"
	"fmt"

	"github.com/qsnake66/infraview/internal/connector"
)

func (c *RedisConnector) GetObjectInfo(ctx context.Context, object string) (*connector.ObjectInfo, error) {
	keyType, err := redisTypeOrNotFound(ctx, c, object)
	if err != nil {
		return nil, err
	}

	ttl, err := redisTTLSeconds(ctx, c, object)
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
		ObjectType: redisObjectTypeName(keyType),
		Columns:    columnNames(schema.Columns),
		Definition: fmt.Sprintf("Redis %s key %q (ttl=%d)", keyType, object, ttl),
	}, nil
}

func (c *RedisConnector) GetSchema(ctx context.Context, object string) (*connector.Schema, error) {
	keyType, err := redisTypeOrNotFound(ctx, c, object)
	if err != nil {
		return nil, err
	}

	ttl, err := redisTTLSeconds(ctx, c, object)
	if err != nil {
		return nil, err
	}

	meta := redisMeta(keyType, ttl)
	var columns []connector.ColumnMeta

	switch keyType {
	case "string":
		columns = []connector.ColumnMeta{
			{Name: "value", DataType: "text", Editable: true},
		}
	case "hash":
		length, err := c.client.HLen(ctx, object).Result()
		if err != nil {
			return nil, normalizeRedisError(err)
		}
		meta["length"] = length
		columns = []connector.ColumnMeta{
			{Name: "field", DataType: "text"},
			{Name: "value", DataType: "text", Editable: true},
		}
	case "list":
		length, err := c.client.LLen(ctx, object).Result()
		if err != nil {
			return nil, normalizeRedisError(err)
		}
		meta["length"] = length
		columns = []connector.ColumnMeta{
			{Name: "index", DataType: "integer"},
			{Name: "value", DataType: "text", Editable: true},
		}
	case "set":
		length, err := c.client.SCard(ctx, object).Result()
		if err != nil {
			return nil, normalizeRedisError(err)
		}
		meta["length"] = length
		columns = []connector.ColumnMeta{
			{Name: "member", DataType: "text", Editable: true},
		}
	case "zset":
		length, err := c.client.ZCard(ctx, object).Result()
		if err != nil {
			return nil, normalizeRedisError(err)
		}
		meta["length"] = length
		columns = []connector.ColumnMeta{
			{Name: "score", DataType: "float", Editable: true},
			{Name: "member", DataType: "text"},
		}
	case "stream":
		length, err := c.client.XLen(ctx, object).Result()
		if err != nil {
			return nil, normalizeRedisError(err)
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

func columnNames(columns []connector.ColumnMeta) []string {
	names := make([]string, 0, len(columns))
	for _, column := range columns {
		names = append(names, column.Name)
	}
	return names
}
