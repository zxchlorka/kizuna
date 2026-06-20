package redis

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/qsnake66/infraview/internal/connector"
	goredis "github.com/redis/go-redis/v9"
)

func (c *RedisConnector) Mutate(ctx context.Context, op connector.MutateOp) (*connector.MutateResult, error) {
	if c.config.ReadOnly {
		return nil, connector.ErrReadOnly
	}
	if strings.TrimSpace(op.Object) == "" {
		return nil, fmt.Errorf("%w: object is required", connector.ErrBadRequest)
	}
	if op.Data == nil {
		op.Data = map[string]any{}
	}
	if op.Where == nil {
		op.Where = map[string]any{}
	}
	originalObject := op.Object

	if op.Type == "insert" {
		if createType := redisCreateType(op.Data); createType != "" {
			if err := c.createKey(ctx, op.Object, createType, op.Data); err != nil {
				return nil, err
			}
			c.invalidateKeyMeta(op.Object)
			return &connector.MutateResult{RowsAffected: 1}, nil
		}
	}

	keyType, err := redisTypeOrNotFound(ctx, c, op.Object)
	if err != nil {
		return nil, err
	}

	if rename, ok := redisRenameFromData(op.Data); ok {
		if err := c.renameKey(ctx, op.Object, rename); err != nil {
			return nil, err
		}
		op.Object = rename
	}

	var rowsAffected int64
	switch op.Type {
	case "update":
		rowsAffected, err = c.updateKey(ctx, keyType, op)
	case "insert":
		rowsAffected, err = c.insertIntoKey(ctx, keyType, op)
	case "delete":
		rowsAffected, err = c.deleteFromKey(ctx, keyType, op)
	default:
		return nil, fmt.Errorf("%w: unsupported mutate type %q", connector.ErrBadRequest, op.Type)
	}
	if err != nil {
		return nil, err
	}

	if ttl, ok, err := redisTTLFromData(op.Data); err != nil {
		return nil, err
	} else if ok {
		applied, err := c.applyTTL(ctx, op.Object, *ttl)
		if err != nil {
			return nil, err
		}
		if applied > rowsAffected {
			rowsAffected = applied
		}
	}

	c.invalidateKeyMeta(originalObject, op.Object)
	return &connector.MutateResult{RowsAffected: rowsAffected}, nil
}

func (c *RedisConnector) DDL(context.Context, connector.DDLOp) error {
	return unsupportedRedisOperation("ddl")
}

func (c *RedisConnector) createKey(ctx context.Context, key, keyType string, data map[string]any) error {
	exists, err := c.client.Exists(ctx, key).Result()
	if err != nil {
		return normalizeRedisError(err)
	}
	if exists > 0 {
		return fmt.Errorf("%w: key %q already exists", connector.ErrConflict, key)
	}

	switch keyType {
	case "string":
		value := redisStringValue(data["value"])
		if err := c.client.Set(ctx, key, value, 0).Err(); err != nil {
			return normalizeRedisError(err)
		}
	case "hash":
		values, err := redisMapValues(data["value"])
		if err != nil {
			return err
		}
		if err := c.client.HSet(ctx, key, values...).Err(); err != nil {
			return normalizeRedisError(err)
		}
	case "list":
		values, err := redisListValues(data["value"])
		if err != nil {
			return err
		}
		if err := c.client.RPush(ctx, key, values...).Err(); err != nil {
			return normalizeRedisError(err)
		}
	case "set":
		members, err := redisSetMembers(data["value"])
		if err != nil {
			return err
		}
		if err := c.client.SAdd(ctx, key, members...).Err(); err != nil {
			return normalizeRedisError(err)
		}
	case "zset":
		members, err := redisZSetMembers(data["value"])
		if err != nil {
			return err
		}
		zMembers := make([]goredis.Z, 0, len(members))
		for _, member := range members {
			zMembers = append(zMembers, member.(goredis.Z))
		}
		if err := c.client.ZAdd(ctx, key, zMembers...).Err(); err != nil {
			return normalizeRedisError(err)
		}
	default:
		return fmt.Errorf("%w: unsupported redis create type %q", connector.ErrBadRequest, keyType)
	}

	if ttl, ok, err := redisTTLFromData(data); err != nil {
		return err
	} else if ok {
		_, err := c.applyTTL(ctx, key, *ttl)
		return err
	}

	return nil
}

func (c *RedisConnector) renameKey(ctx context.Context, from, to string) error {
	if strings.TrimSpace(to) == "" {
		return fmt.Errorf("%w: rename target is required", connector.ErrBadRequest)
	}
	if err := c.client.Rename(ctx, from, to).Err(); err != nil {
		return normalizeRedisError(err)
	}
	return nil
}

func (c *RedisConnector) applyTTL(ctx context.Context, key string, ttl int64) (int64, error) {
	switch {
	case ttl == -1:
		ok, err := c.client.Persist(ctx, key).Result()
		if err != nil {
			return 0, normalizeRedisError(err)
		}
		if !ok {
			return 0, nil
		}
		return 1, nil
	case ttl == 0:
		count, err := c.client.Del(ctx, key).Result()
		if err != nil {
			return 0, normalizeRedisError(err)
		}
		return count, nil
	case ttl > 0:
		ok, err := c.client.Expire(ctx, key, time.Duration(ttl)*time.Second).Result()
		if err != nil {
			return 0, normalizeRedisError(err)
		}
		if !ok {
			return 0, fmt.Errorf("%w: ttl was not applied to %q", connector.ErrConflict, key)
		}
		return 1, nil
	default:
		return 0, fmt.Errorf("%w: ttl must be -1, 0, or a positive number", connector.ErrBadRequest)
	}
}

func (c *RedisConnector) updateKey(ctx context.Context, keyType string, op connector.MutateOp) (int64, error) {
	switch keyType {
	case "string":
		if _, hasValue := op.Data["value"]; !hasValue {
			if len(op.Data) == 0 {
				return 0, fmt.Errorf("%w: update payload is empty", connector.ErrBadRequest)
			}
			return 0, nil
		}
		value := redisStringValue(op.Data["value"])
		if _, ttlSpecified := op.Data["ttl"]; ttlSpecified {
			if err := c.client.Set(ctx, op.Object, value, 0).Err(); err != nil {
				return 0, normalizeRedisError(err)
			}
			return 1, nil
		}
		if err := c.client.SetArgs(ctx, op.Object, value, goredis.SetArgs{KeepTTL: true}).Err(); err != nil {
			return 0, normalizeRedisError(err)
		}
		return 1, nil
	case "hash":
		field := strings.TrimSpace(redisStringValue(op.Where["field"]))
		if field == "" {
			field = strings.TrimSpace(redisStringValue(op.Data["field"]))
		}
		if field == "" {
			return 0, fmt.Errorf("%w: hash field is required", connector.ErrBadRequest)
		}
		if err := c.client.HSet(ctx, op.Object, field, redisStringValue(op.Data["value"])).Err(); err != nil {
			return 0, normalizeRedisError(err)
		}
		return 1, nil
	case "list":
		index, err := redisInt64Value(op.Where["index"])
		if err != nil {
			return 0, fmt.Errorf("%w: list index is required", connector.ErrBadRequest)
		}
		if err := c.client.LSet(ctx, op.Object, index, redisStringValue(op.Data["value"])).Err(); err != nil {
			return 0, normalizeRedisError(err)
		}
		return 1, nil
	case "zset":
		member := redisStringValue(op.Where["member"])
		if member == "" {
			return 0, fmt.Errorf("%w: sorted set member is required", connector.ErrBadRequest)
		}
		score, err := redisFloat64Value(op.Data["score"])
		if err != nil {
			return 0, fmt.Errorf("%w: sorted set score is required", connector.ErrBadRequest)
		}
		if err := c.client.ZAdd(ctx, op.Object, goredis.Z{Score: score, Member: member}).Err(); err != nil {
			return 0, normalizeRedisError(err)
		}
		return 1, nil
	case "json":
		return c.updateJSONPath(ctx, op.Object, op)
	default:
		if len(op.Data) > 0 {
			return 0, fmt.Errorf("%w: update is not supported for redis type %q", connector.ErrBadRequest, keyType)
		}
		return 0, nil
	}
}

func (c *RedisConnector) insertIntoKey(ctx context.Context, keyType string, op connector.MutateOp) (int64, error) {
	switch keyType {
	case "string":
		if err := c.client.Set(ctx, op.Object, redisStringValue(op.Data["value"]), 0).Err(); err != nil {
			return 0, normalizeRedisError(err)
		}
		return 1, nil
	case "hash":
		field := strings.TrimSpace(redisStringValue(op.Data["field"]))
		if field == "" {
			return 0, fmt.Errorf("%w: hash field is required", connector.ErrBadRequest)
		}
		if err := c.client.HSet(ctx, op.Object, field, redisStringValue(op.Data["value"])).Err(); err != nil {
			return 0, normalizeRedisError(err)
		}
		return 1, nil
	case "list":
		direction := strings.ToLower(strings.TrimSpace(redisStringValue(op.Data["direction"])))
		value := redisStringValue(op.Data["value"])
		if direction == "left" {
			if err := c.client.LPush(ctx, op.Object, value).Err(); err != nil {
				return 0, normalizeRedisError(err)
			}
			return 1, nil
		}
		if err := c.client.RPush(ctx, op.Object, value).Err(); err != nil {
			return 0, normalizeRedisError(err)
		}
		return 1, nil
	case "set":
		member := redisStringValue(op.Data["member"])
		if member == "" {
			member = redisStringValue(op.Data["value"])
		}
		if member == "" {
			return 0, fmt.Errorf("%w: set member is required", connector.ErrBadRequest)
		}
		count, err := c.client.SAdd(ctx, op.Object, member).Result()
		if err != nil {
			return 0, normalizeRedisError(err)
		}
		return count, nil
	case "zset":
		member := redisStringValue(op.Data["member"])
		if member == "" {
			member = redisStringValue(op.Data["value"])
		}
		score, err := redisFloat64Value(op.Data["score"])
		if err != nil {
			return 0, fmt.Errorf("%w: sorted set score is required", connector.ErrBadRequest)
		}
		count, err := c.client.ZAdd(ctx, op.Object, goredis.Z{Score: score, Member: member}).Result()
		if err != nil {
			return 0, normalizeRedisError(err)
		}
		return count, nil
	default:
		return 0, fmt.Errorf("%w: insert is not supported for redis type %q", connector.ErrBadRequest, keyType)
	}
}

func (c *RedisConnector) deleteFromKey(ctx context.Context, keyType string, op connector.MutateOp) (int64, error) {
	if len(op.Where) == 0 {
		count, err := c.client.Del(ctx, op.Object).Result()
		if err != nil {
			return 0, normalizeRedisError(err)
		}
		if count == 0 {
			return 0, fmt.Errorf("%w: key %q not found", connector.ErrRelationNotFound, op.Object)
		}
		return count, nil
	}

	switch keyType {
	case "hash":
		field := redisStringValue(op.Where["field"])
		count, err := c.client.HDel(ctx, op.Object, field).Result()
		if err != nil {
			return 0, normalizeRedisError(err)
		}
		if count == 0 {
			return 0, fmt.Errorf("%w: hash field %q not found", connector.ErrRelationNotFound, field)
		}
		return count, nil
	case "list":
		index, err := redisInt64Value(op.Where["index"])
		if err != nil {
			return 0, fmt.Errorf("%w: list index is required", connector.ErrBadRequest)
		}
		marker := fmt.Sprintf("__infraview_delete__:%d", time.Now().UnixNano())
		if err := c.client.LSet(ctx, op.Object, index, marker).Err(); err != nil {
			return 0, normalizeRedisError(err)
		}
		count, err := c.client.LRem(ctx, op.Object, 1, marker).Result()
		if err != nil {
			return 0, normalizeRedisError(err)
		}
		return count, nil
	case "set":
		member := redisStringValue(op.Where["member"])
		count, err := c.client.SRem(ctx, op.Object, member).Result()
		if err != nil {
			return 0, normalizeRedisError(err)
		}
		return count, nil
	case "zset":
		member := redisStringValue(op.Where["member"])
		count, err := c.client.ZRem(ctx, op.Object, member).Result()
		if err != nil {
			return 0, normalizeRedisError(err)
		}
		return count, nil
	default:
		return 0, fmt.Errorf("%w: delete with where is not supported for redis type %q", connector.ErrBadRequest, keyType)
	}
}
