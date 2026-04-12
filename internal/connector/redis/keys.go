package redis

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"strings"
	"sync"

	"github.com/qsnake66/infraview/internal/config"
	"github.com/qsnake66/infraview/internal/connector"
)

var errRedisScanLimitReached = errors.New("redis scan limit reached")

func (c *RedisConnector) ListObjects(ctx context.Context, path string) ([]connector.Object, error) {
	keys, truncated, err := c.scanKeys(ctx, path)
	if err != nil {
		return nil, err
	}

	if path == "" {
		return c.buildRootObjects(ctx, keys, truncated)
	}
	return c.buildNamespaceObjects(ctx, path, keys, truncated)
}

func (c *RedisConnector) scanKeys(ctx context.Context, path string) ([]string, bool, error) {
	pattern := "*"
	if path != "" {
		pattern = path + c.redis.separator + "*"
	}

	seen := make(map[string]struct{})
	keys := make([]string, 0, 128)
	truncated := false
	var mu sync.Mutex

	addKey := func(key string) error {
		mu.Lock()
		defer mu.Unlock()

		if truncated {
			return errRedisScanLimitReached
		}
		if _, ok := seen[key]; ok {
			return nil
		}

		seen[key] = struct{}{}
		keys = append(keys, key)
		if len(keys) >= maxScanKeys {
			truncated = true
			return errRedisScanLimitReached
		}
		return nil
	}

	if c.redis.mode == config.RedisModeCluster {
		if c.clusterMasterScanner == nil {
			return nil, false, fmt.Errorf("redis cluster master scanner is not configured")
		}

		scanCtx, cancel := context.WithCancel(ctx)
		defer cancel()

		err := c.clusterMasterScanner(scanCtx, func(ctx context.Context, client redisScanClient) error {
			err := scanPattern(ctx, client, pattern, addKey)
			if errors.Is(err, errRedisScanLimitReached) {
				cancel()
				return err
			}
			if truncated && errors.Is(err, context.Canceled) {
				return errRedisScanLimitReached
			}
			return err
		})
		if err != nil && !errors.Is(err, errRedisScanLimitReached) && !(truncated && errors.Is(err, context.Canceled)) {
			return nil, false, normalizeRedisError(err)
		}
	} else {
		err := scanPattern(ctx, c.client, pattern, addKey)
		if err != nil && !errors.Is(err, errRedisScanLimitReached) {
			return nil, false, err
		}
	}

	sort.Strings(keys)
	return keys, truncated, nil
}

func scanPattern(ctx context.Context, client redisScanClient, pattern string, addKey func(key string) error) error {
	var cursor uint64

	for {
		batch, nextCursor, err := client.Scan(ctx, cursor, pattern, 1000).Result()
		if err != nil {
			return normalizeRedisError(err)
		}

		for _, key := range batch {
			if err := addKey(key); err != nil {
				return err
			}
		}

		cursor = nextCursor
		if cursor == 0 {
			return nil
		}
	}
}

func (c *RedisConnector) buildRootObjects(ctx context.Context, keys []string, truncated bool) ([]connector.Object, error) {
	namespaces := make(map[string]int64)
	leafKeys := make([]string, 0)

	for _, key := range keys {
		if root, ok := redisNamespaceRoot(key, c.redis.separator); ok {
			namespaces[root]++
			continue
		}
		leafKeys = append(leafKeys, key)
	}

	objects := make([]connector.Object, 0, len(namespaces)+len(leafKeys))
	namespaceNames := make([]string, 0, len(namespaces))
	for name := range namespaces {
		namespaceNames = append(namespaceNames, name)
	}
	sort.Strings(namespaceNames)
	for _, name := range namespaceNames {
		meta := map[string]any{}
		if truncated {
			meta["truncated"] = true
		}
		objects = append(objects, connector.Object{
			Name:     name,
			Type:     "namespace",
			Schema:   "",
			RowCount: namespaces[name],
			Path:     name,
			Meta:     meta,
		})
	}

	for _, key := range leafKeys {
		object, err := c.describeLeafObject(ctx, key, key, truncated)
		if err != nil {
			return nil, err
		}
		objects = append(objects, object)
	}

	return objects, nil
}

func (c *RedisConnector) buildNamespaceObjects(ctx context.Context, path string, keys []string, truncated bool) ([]connector.Object, error) {
	namespaces := make(map[string]int64)
	leaves := make([]connector.Object, 0)
	prefix := path + c.redis.separator

	for _, key := range keys {
		if !strings.HasPrefix(key, prefix) {
			continue
		}

		rest := strings.TrimPrefix(key, prefix)
		if rest == "" {
			continue
		}

		if next, tail, ok := strings.Cut(rest, c.redis.separator); ok && next != "" && tail != "" {
			namespaces[next]++
			continue
		}

		object, err := c.describeLeafObject(ctx, rest, key, truncated)
		if err != nil {
			return nil, err
		}
		leaves = append(leaves, object)
	}

	objects := make([]connector.Object, 0, len(namespaces)+len(leaves))
	namespaceNames := make([]string, 0, len(namespaces))
	for name := range namespaces {
		namespaceNames = append(namespaceNames, name)
	}
	sort.Strings(namespaceNames)
	for _, name := range namespaceNames {
		meta := map[string]any{}
		if truncated {
			meta["truncated"] = true
		}
		objects = append(objects, connector.Object{
			Name:     name,
			Type:     "namespace",
			Schema:   "",
			RowCount: namespaces[name],
			Path:     path + c.redis.separator + name,
			Meta:     meta,
		})
	}

	objects = append(objects, leaves...)
	sort.SliceStable(objects, func(i, j int) bool {
		if objects[i].Type == objects[j].Type {
			return objects[i].Name < objects[j].Name
		}
		if objects[i].Type == "namespace" {
			return true
		}
		if objects[j].Type == "namespace" {
			return false
		}
		return objects[i].Name < objects[j].Name
	})
	return objects, nil
}

func (c *RedisConnector) describeLeafObject(ctx context.Context, name, key string, truncated bool) (connector.Object, error) {
	keyType, err := redisTypeOrNotFound(ctx, c, key)
	if err != nil {
		return connector.Object{}, err
	}

	ttl, err := redisTTLSeconds(ctx, c, key)
	if err != nil {
		return connector.Object{}, err
	}

	meta := redisMeta(keyType, ttl)
	if truncated {
		meta["truncated"] = true
	}

	return connector.Object{
		Name:       name,
		Type:       redisObjectTypeName(keyType),
		Schema:     "",
		RowCount:   0,
		Path:       key,
		TTLSeconds: redisTTLPointer(ttl),
		Meta:       meta,
	}, nil
}
