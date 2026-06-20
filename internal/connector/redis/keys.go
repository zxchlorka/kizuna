package redis

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/qsnake66/infraview/internal/config"
	"github.com/qsnake66/infraview/internal/connector"
	goredis "github.com/redis/go-redis/v9"
)

var errRedisScanLimitReached = errors.New("redis scan limit reached")

const (
	// Budget for one ListObjectsPage call. The page ends when any of these is
	// hit, so a pattern that matches nothing on a huge keyspace still returns
	// quickly with a cursor instead of iterating the whole database.
	pageMaxKeys    = 1000
	pageMaxScans   = 100 // SCAN iterations (~100k examined entries at COUNT 1000)
	pageTimeBudget = 1500 * time.Millisecond

	scanBatchCount    = 1000
	describeChunkSize = 500

	// The plain ListObjects contract accumulates pages up to these caps.
	legacyTimeBudget = 5 * time.Second
)

// ListObjects keeps the plain Connector contract: it accumulates pages until
// the scan completes or the legacy 10k-keys / 5s budget runs out.
func (c *RedisConnector) ListObjects(ctx context.Context, path string) ([]connector.Object, error) {
	keys := make([]string, 0, 256)
	seen := make(map[string]struct{})
	cursor := ""
	truncated := false
	deadline := time.Now().Add(legacyTimeBudget)

	for {
		page, err := c.scanKeysPage(ctx, path, cursor, "")
		if err != nil {
			return nil, err
		}
		for _, key := range page.keys {
			if _, ok := seen[key]; ok {
				continue
			}
			seen[key] = struct{}{}
			keys = append(keys, key)
		}
		cursor = page.nextCursor
		if cursor == "" {
			break
		}
		if len(keys) >= maxScanKeys || time.Now().After(deadline) {
			truncated = true
			break
		}
	}

	if len(keys) > maxScanKeys {
		keys = keys[:maxScanKeys]
		truncated = true
	}

	sort.Strings(keys)
	if path == "" {
		return c.buildRootObjects(ctx, keys, truncated)
	}
	return c.buildNamespaceObjects(ctx, path, keys, truncated)
}

// ListObjectsPage implements connector.PagedObjectLister: it returns one
// budgeted slice of the keyspace plus a cursor to continue from.
func (c *RedisConnector) ListObjectsPage(ctx context.Context, opts connector.ObjectPageOpts) (*connector.ObjectPage, error) {
	page, err := c.scanKeysPage(ctx, opts.Path, opts.Cursor, opts.Node)
	if err != nil {
		return nil, err
	}

	sort.Strings(page.keys)
	truncated := page.nextCursor != ""

	var objects []connector.Object
	if opts.Path == "" {
		objects, err = c.buildRootObjects(ctx, page.keys, truncated)
	} else {
		objects, err = c.buildNamespaceObjects(ctx, opts.Path, page.keys, truncated)
	}
	if err != nil {
		return nil, err
	}

	return &connector.ObjectPage{
		Objects:    objects,
		NextCursor: page.nextCursor,
		Truncated:  truncated,
	}, nil
}

type redisKeyPage struct {
	keys       []string
	nextCursor string
}

type scanBudget struct {
	maxKeys  int
	maxScans int
	deadline time.Time
	scans    int
}

func newScanBudget() *scanBudget {
	return &scanBudget{
		maxKeys:  pageMaxKeys,
		maxScans: pageMaxScans,
		deadline: time.Now().Add(pageTimeBudget),
	}
}

func (b *scanBudget) spent(collected int) bool {
	return collected >= b.maxKeys || b.scans >= b.maxScans || time.Now().After(b.deadline)
}

func (c *RedisConnector) scanKeysPage(ctx context.Context, path, cursorToken, node string) (*redisKeyPage, error) {
	pattern := "*"
	if path != "" {
		pattern = path + c.redis.separator + "*"
	}

	if c.redis.mode == config.RedisModeCluster {
		if node != "" {
			return c.scanNodePage(ctx, pattern, cursorToken, node)
		}
		return c.scanClusterPage(ctx, pattern, cursorToken)
	}
	if node != "" {
		return nil, fmt.Errorf("%w: node-scoped listing is only available in cluster mode", connector.ErrBadRequest)
	}
	return c.scanSinglePage(ctx, c.client, pattern, cursorToken)
}

func (c *RedisConnector) scanSinglePage(ctx context.Context, client redisScanClient, pattern, cursorToken string) (*redisKeyPage, error) {
	cursor, err := parseSingleCursor(cursorToken)
	if err != nil {
		return nil, err
	}

	budget := newScanBudget()
	keys := make([]string, 0, 128)
	seen := make(map[string]struct{})

	nextCursor, done, err := scanIntoPage(ctx, client, pattern, cursor, budget, &keys, seen)
	if err != nil {
		return nil, err
	}

	page := &redisKeyPage{keys: keys}
	if !done {
		page.nextCursor = encodeSingleCursor(nextCursor)
	}
	return page, nil
}

func (c *RedisConnector) scanNodePage(ctx context.Context, pattern, cursorToken, node string) (*redisKeyPage, error) {
	if c.topology == nil {
		return nil, fmt.Errorf("redis cluster topology is not configured")
	}

	masters, err := c.topology.Masters(ctx)
	if err != nil {
		return nil, normalizeRedisError(err)
	}
	if !containsString(masters, node) {
		return nil, fmt.Errorf("%w: unknown cluster node %q", connector.ErrBadRequest, node)
	}

	client, err := c.topology.NodeScanClient(node)
	if err != nil {
		return nil, normalizeRedisError(err)
	}
	return c.scanSinglePage(ctx, client, pattern, cursorToken)
}

func (c *RedisConnector) scanClusterPage(ctx context.Context, pattern, cursorToken string) (*redisKeyPage, error) {
	if c.topology == nil {
		return nil, fmt.Errorf("redis cluster topology is not configured")
	}

	masters, err := c.topology.Masters(ctx)
	if err != nil {
		return nil, normalizeRedisError(err)
	}
	if len(masters) == 0 {
		return nil, fmt.Errorf("%w: no cluster master nodes discovered", connector.ErrUnavailable)
	}

	startAddr, cursor, err := parseClusterCursor(cursorToken)
	if err != nil {
		return nil, err
	}

	nodeIndex := 0
	if startAddr != "" {
		nodeIndex = sort.SearchStrings(masters, startAddr)
		if nodeIndex >= len(masters) {
			// Topology shrank below the saved position; treat the scan as done.
			return &redisKeyPage{}, nil
		}
		if masters[nodeIndex] != startAddr {
			// Topology changed; the saved cursor is meaningless on another node.
			cursor = 0
		}
	}

	budget := newScanBudget()
	keys := make([]string, 0, 128)
	seen := make(map[string]struct{})

	for nodeIndex < len(masters) {
		client, err := c.topology.NodeScanClient(masters[nodeIndex])
		if err != nil {
			return nil, normalizeRedisError(err)
		}

		nextCursor, done, err := scanIntoPage(ctx, client, pattern, cursor, budget, &keys, seen)
		if err != nil {
			return nil, err
		}
		if !done {
			return &redisKeyPage{keys: keys, nextCursor: encodeClusterCursor(masters[nodeIndex], nextCursor)}, nil
		}

		nodeIndex++
		cursor = 0
		if nodeIndex < len(masters) && budget.spent(len(keys)) {
			return &redisKeyPage{keys: keys, nextCursor: encodeClusterCursor(masters[nodeIndex], 0)}, nil
		}
	}

	return &redisKeyPage{keys: keys}, nil
}

// scanIntoPage runs SCAN iterations against one client until the scan
// completes (done=true) or the shared page budget is spent.
func scanIntoPage(
	ctx context.Context,
	client redisScanClient,
	pattern string,
	cursor uint64,
	budget *scanBudget,
	keys *[]string,
	seen map[string]struct{},
) (uint64, bool, error) {
	for {
		if budget.spent(len(*keys)) {
			return cursor, false, nil
		}

		batch, next, err := client.Scan(ctx, cursor, pattern, scanBatchCount).Result()
		if err != nil {
			return 0, false, normalizeRedisError(err)
		}
		budget.scans++

		for _, key := range batch {
			if _, ok := seen[key]; ok {
				continue
			}
			seen[key] = struct{}{}
			*keys = append(*keys, key)
		}

		cursor = next
		if cursor == 0 {
			return 0, true, nil
		}
	}
}

func encodeSingleCursor(cursor uint64) string {
	return "s:" + strconv.FormatUint(cursor, 10)
}

func parseSingleCursor(token string) (uint64, error) {
	if token == "" {
		return 0, nil
	}
	rest, ok := strings.CutPrefix(token, "s:")
	if !ok {
		return 0, badCursorError(token)
	}
	cursor, err := strconv.ParseUint(rest, 10, 64)
	if err != nil {
		return 0, badCursorError(token)
	}
	return cursor, nil
}

// Cluster cursors put the node address last because it contains ":" itself.
func encodeClusterCursor(addr string, cursor uint64) string {
	return "c:" + strconv.FormatUint(cursor, 10) + ":" + addr
}

func parseClusterCursor(token string) (string, uint64, error) {
	if token == "" {
		return "", 0, nil
	}
	parts := strings.SplitN(token, ":", 3)
	if len(parts) != 3 || parts[0] != "c" || parts[2] == "" {
		return "", 0, badCursorError(token)
	}
	cursor, err := strconv.ParseUint(parts[1], 10, 64)
	if err != nil {
		return "", 0, badCursorError(token)
	}
	return parts[2], cursor, nil
}

func badCursorError(token string) error {
	return fmt.Errorf("%w: invalid scan cursor %q", connector.ErrBadRequest, token)
}

func containsString(values []string, target string) bool {
	for _, value := range values {
		if value == target {
			return true
		}
	}
	return false
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

	objects := namespaceObjects(namespaces, "", c.redis.separator, truncated)

	leaves, err := c.describeLeafObjects(ctx, leafKeys, func(key string) string { return key }, truncated)
	if err != nil {
		return nil, err
	}

	return append(objects, leaves...), nil
}

func (c *RedisConnector) buildNamespaceObjects(ctx context.Context, path string, keys []string, truncated bool) ([]connector.Object, error) {
	namespaces := make(map[string]int64)
	leafKeys := make([]string, 0)
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

		leafKeys = append(leafKeys, key)
	}

	objects := namespaceObjects(namespaces, path, c.redis.separator, truncated)

	leaves, err := c.describeLeafObjects(ctx, leafKeys, func(key string) string { return strings.TrimPrefix(key, prefix) }, truncated)
	if err != nil {
		return nil, err
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

func namespaceObjects(counts map[string]int64, parentPath, separator string, truncated bool) []connector.Object {
	names := make([]string, 0, len(counts))
	for name := range counts {
		names = append(names, name)
	}
	sort.Strings(names)

	objects := make([]connector.Object, 0, len(names))
	for _, name := range names {
		meta := map[string]any{}
		if truncated {
			meta["truncated"] = true
		}
		path := name
		if parentPath != "" {
			path = parentPath + separator + name
		}
		objects = append(objects, connector.Object{
			Name:     name,
			Type:     "namespace",
			Schema:   "",
			RowCount: counts[name],
			Path:     path,
			Meta:     meta,
		})
	}
	return objects
}

// describeLeafObjects resolves TYPE and TTL for all leaf keys with pipelined
// batches instead of two sequential round trips per key. Keys that expire
// between SCAN and the describe pipeline are silently dropped.
func (c *RedisConnector) describeLeafObjects(
	ctx context.Context,
	keys []string,
	displayName func(key string) string,
	truncated bool,
) ([]connector.Object, error) {
	objects := make([]connector.Object, 0, len(keys))

	for start := 0; start < len(keys); start += describeChunkSize {
		end := minInt(start+describeChunkSize, len(keys))
		chunk := keys[start:end]

		typeCmds := make([]*goredis.StatusCmd, len(chunk))
		ttlCmds := make([]*goredis.DurationCmd, len(chunk))
		_, err := c.client.Pipelined(ctx, func(pipe goredis.Pipeliner) error {
			for i, key := range chunk {
				typeCmds[i] = pipe.Type(ctx, key)
				ttlCmds[i] = pipe.TTL(ctx, key)
			}
			return nil
		})
		if err != nil {
			return nil, normalizeRedisError(err)
		}

		for i, key := range chunk {
			keyType, err := typeCmds[i].Result()
			if err != nil {
				if errors.Is(err, goredis.Nil) {
					continue
				}
				return nil, normalizeRedisError(err)
			}
			keyType = normalizeRedisServerType(keyType)
			if keyType == "" || keyType == "none" {
				continue
			}

			ttlValue, err := ttlCmds[i].Result()
			if err != nil {
				if errors.Is(err, goredis.Nil) {
					continue
				}
				return nil, normalizeRedisError(err)
			}
			ttl := int64(ttlValue)
			if ttlValue >= 0 {
				ttl = int64(ttlValue / time.Second)
			}
			c.storeKeyMeta(key, redisKeyMeta{keyType: keyType, ttl: ttl})

			meta := redisMeta(keyType, ttl)
			if truncated {
				meta["truncated"] = true
			}

			objects = append(objects, connector.Object{
				Name:       displayName(key),
				Type:       redisObjectTypeName(keyType),
				Schema:     "",
				RowCount:   0,
				Path:       key,
				TTLSeconds: redisTTLPointer(ttl),
				Meta:       meta,
			})
		}
	}

	return objects, nil
}
