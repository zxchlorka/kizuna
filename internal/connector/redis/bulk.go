package redis

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/zxchlorka/kizuna/internal/config"
	"github.com/zxchlorka/kizuna/internal/connector"
)

const (
	defaultRedisBulkBatchSize = 100
	maxRedisBulkBatchSize     = 1000
)

func (c *RedisConnector) mutateBulk(ctx context.Context, op connector.BulkMutateOp) (*connector.BulkMutateResult, error) {
	// Preview is read-only (it only counts matching keys); the actual delete is blocked.
	if c.config.ReadOnly && op.Execute {
		return nil, connector.ErrReadOnly
	}
	pattern := strings.TrimSpace(op.Pattern)
	if pattern == "" {
		return nil, fmt.Errorf("%w: pattern is required", connector.ErrBadRequest)
	}
	if pattern == "*" && !op.ConfirmAll {
		return nil, fmt.Errorf("%w: pattern \"*\" requires confirm_all=true", connector.ErrBadRequest)
	}
	if op.Preview == op.Execute {
		return nil, fmt.Errorf("%w: exactly one of preview or execute must be true", connector.ErrBadRequest)
	}

	batchSize := op.BatchSize
	if batchSize <= 0 {
		batchSize = defaultRedisBulkBatchSize
	}
	if batchSize > maxRedisBulkBatchSize {
		batchSize = maxRedisBulkBatchSize
	}

	startedAt := time.Now()
	total := 0
	deleted := int64(0)
	batch := make([]string, 0, batchSize)

	flush := func() error {
		if len(batch) == 0 {
			return nil
		}
		count, err := c.deleteRedisKeys(ctx, batch)
		if err != nil {
			return err
		}
		deleted += count
		batch = batch[:0]
		return nil
	}

	err := c.scanMatchingKeys(ctx, pattern, func(key string) error {
		total++
		if op.Preview {
			return nil
		}
		batch = append(batch, key)
		if len(batch) >= batchSize {
			return flush()
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	if err := flush(); err != nil {
		return nil, err
	}

	durationMs := time.Since(startedAt).Milliseconds()
	if op.Preview {
		return &connector.BulkMutateResult{
			Applied:      total,
			RowsAffected: 0,
			Message:      fmt.Sprintf("Preview matched %d keys in %dms", total, durationMs),
		}, nil
	}

	return &connector.BulkMutateResult{
		Applied:      total,
		RowsAffected: deleted,
		Message:      fmt.Sprintf("Deleted %d of %d matched keys in %dms", deleted, total, durationMs),
	}, nil
}

func (c *RedisConnector) scanMatchingKeys(ctx context.Context, pattern string, onKey func(key string) error) error {
	seen := make(map[string]struct{})
	visit := func(key string) error {
		if _, ok := seen[key]; ok {
			return nil
		}
		seen[key] = struct{}{}
		return onKey(key)
	}

	if c.redis.mode == config.RedisModeCluster {
		if c.topology == nil {
			return fmt.Errorf("redis cluster topology is not configured")
		}
		masters, err := c.topology.Masters(ctx)
		if err != nil {
			return normalizeRedisError(err)
		}
		for _, addr := range masters {
			client, err := c.topology.NodeScanClient(addr)
			if err != nil {
				return normalizeRedisError(err)
			}
			if err := scanPattern(ctx, client, pattern, visit); err != nil {
				return err
			}
		}
		return nil
	}
	return scanPattern(ctx, c.client, pattern, visit)
}

// scanPattern iterates the full keyspace for one client. Unlike the paged tree
// scan it is intentionally unbounded: bulk delete and completions own their
// stop conditions via the onKey callback.
func scanPattern(ctx context.Context, client redisScanClient, pattern string, onKey func(key string) error) error {
	var cursor uint64

	for {
		batch, nextCursor, err := client.Scan(ctx, cursor, pattern, scanBatchCount).Result()
		if err != nil {
			return normalizeRedisError(err)
		}

		for _, key := range batch {
			if err := onKey(key); err != nil {
				return err
			}
		}

		cursor = nextCursor
		if cursor == 0 {
			return nil
		}
	}
}

func (c *RedisConnector) deleteRedisKeys(ctx context.Context, keys []string) (int64, error) {
	count, err := c.client.Del(ctx, keys...).Result()
	if err == nil {
		c.invalidateKeyMeta(keys...)
		return count, nil
	}
	if !strings.Contains(strings.ToLower(err.Error()), "crossslot") {
		return 0, normalizeRedisError(err)
	}

	var total int64
	for _, key := range keys {
		count, delErr := c.client.Del(ctx, key).Result()
		if delErr != nil && !errors.Is(delErr, context.Canceled) {
			return total, normalizeRedisError(delErr)
		}
		total += count
	}
	c.invalidateKeyMeta(keys...)
	return total, nil
}
