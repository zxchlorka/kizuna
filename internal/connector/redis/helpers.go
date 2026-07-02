package redis

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/qsnake66/kizuna/internal/connector"
	goredis "github.com/redis/go-redis/v9"
)

const (
	defaultRedisLimit = 100
	maxRedisLimit     = 1000
	maxScanKeys       = 10000

	redisMetaCacheTTL    = 10 * time.Second
	maxRedisMetaCacheLen = 512
)

func redisTypeOrNotFound(ctx context.Context, c *RedisConnector, key string) (string, error) {
	keyType, err := c.client.Type(ctx, key).Result()
	if err != nil {
		return "", normalizeRedisError(err)
	}

	keyType = normalizeRedisServerType(keyType)
	if keyType == "" || keyType == "none" {
		return "", fmt.Errorf("%w: key %q not found", connector.ErrRelationNotFound, key)
	}

	return keyType, nil
}

func normalizeRedisServerType(keyType string) string {
	keyType = strings.ToLower(strings.TrimSpace(keyType))
	switch keyType {
	case "rejson-rl", "json":
		return "json"
	default:
		return keyType
	}
}

func redisTTLSeconds(ctx context.Context, c *RedisConnector, key string) (int64, error) {
	ttl, err := c.client.TTL(ctx, key).Result()
	if err != nil {
		return 0, normalizeRedisError(err)
	}
	if ttl < 0 {
		return int64(ttl), nil
	}
	return int64(ttl / time.Second), nil
}

func (c *RedisConnector) getKeyMeta(ctx context.Context, key string) (redisKeyMeta, error) {
	if meta, ok := c.cachedKeyMeta(key, false); ok {
		return meta, nil
	}

	keyType, err := redisTypeOrNotFound(ctx, c, key)
	if err != nil {
		return redisKeyMeta{}, err
	}
	ttl, err := redisTTLSeconds(ctx, c, key)
	if err != nil {
		return redisKeyMeta{}, err
	}

	meta := redisKeyMeta{keyType: keyType, ttl: ttl}
	c.storeKeyMeta(key, meta)
	return meta, nil
}

func (c *RedisConnector) cachedKeyMeta(key string, requireLength bool) (redisKeyMeta, bool) {
	c.metaMu.RLock()
	defer c.metaMu.RUnlock()

	bucket, ok := c.keyMetaCache[key]
	if !ok || time.Now().After(bucket.expires) {
		return redisKeyMeta{}, false
	}
	if requireLength && bucket.meta.length == nil {
		return redisKeyMeta{}, false
	}
	return bucket.meta, true
}

func (c *RedisConnector) storeKeyMeta(key string, meta redisKeyMeta) {
	c.metaMu.Lock()
	defer c.metaMu.Unlock()

	if c.keyMetaCache == nil {
		c.keyMetaCache = make(map[string]redisKeyMetaBucket)
	}
	if existing, ok := c.keyMetaCache[key]; ok && meta.length == nil {
		meta.length = existing.meta.length
	}
	if len(c.keyMetaCache) >= maxRedisMetaCacheLen {
		now := time.Now()
		for cacheKey, bucket := range c.keyMetaCache {
			if now.After(bucket.expires) {
				delete(c.keyMetaCache, cacheKey)
			}
		}
	}
	if len(c.keyMetaCache) >= maxRedisMetaCacheLen {
		for cacheKey := range c.keyMetaCache {
			delete(c.keyMetaCache, cacheKey)
			break
		}
	}
	c.keyMetaCache[key] = redisKeyMetaBucket{
		meta:    meta,
		expires: time.Now().Add(redisMetaCacheTTL),
	}
}

func (c *RedisConnector) rememberKeyLength(key string, keyType string, ttl int64, length int64) {
	value := length
	c.storeKeyMeta(key, redisKeyMeta{
		keyType: keyType,
		ttl:     ttl,
		length:  &value,
	})
}

func (c *RedisConnector) invalidateKeyMeta(keys ...string) {
	c.metaMu.Lock()
	defer c.metaMu.Unlock()

	for _, key := range keys {
		delete(c.keyMetaCache, key)
	}
}

func redisDataResult(
	columns []connector.ColumnMeta,
	rows []map[string]any,
	total int64,
	meta map[string]any,
	offset int,
) *connector.DataResult {
	if meta == nil {
		meta = make(map[string]any)
	}
	return &connector.DataResult{
		Columns: columns,
		Rows:    rows,
		Total:   total,
		HasMore: int64(offset+len(rows)) < total,
		Meta:    meta,
	}
}

func redisColumns(names ...string) []connector.ColumnMeta {
	cols := make([]connector.ColumnMeta, 0, len(names))
	for _, name := range names {
		cols = append(cols, connector.ColumnMeta{Name: name, DataType: "text", Editable: true})
	}
	return cols
}

func redisNamespaceRoot(key, separator string) (string, bool) {
	if separator == "" {
		return "", false
	}
	prefix, rest, ok := strings.Cut(key, separator)
	if !ok || prefix == "" || rest == "" {
		return "", false
	}
	return prefix, true
}

func normalizeRedisOpts(opts connector.DataOpts) connector.DataOpts {
	if opts.Offset < 0 {
		opts.Offset = 0
	}
	if opts.Limit <= 0 {
		opts.Limit = defaultRedisLimit
	}
	if opts.Limit > maxRedisLimit {
		opts.Limit = maxRedisLimit
	}
	if opts.OrderDir != "desc" {
		opts.OrderDir = "asc"
	}
	return opts
}

func redisObjectTypeName(keyType string) string {
	switch strings.ToLower(strings.TrimSpace(keyType)) {
	case "string":
		return "redis_string"
	case "hash":
		return "redis_hash"
	case "list":
		return "redis_list"
	case "set":
		return "redis_set"
	case "zset":
		return "redis_zset"
	case "stream":
		return "redis_stream"
	case "json":
		return "redis_json"
	default:
		return keyType
	}
}

func redisMeta(keyType string, ttlSeconds int64) map[string]any {
	return map[string]any{
		"type": redisObjectTypeName(keyType),
		"ttl":  ttlSeconds,
	}
}

func redisStringPtr(value string) *string {
	v := value
	return &v
}

func redisTTLPointer(ttl int64) *int64 {
	v := ttl
	return &v
}

func redisSortedKeys[K comparable](m map[K]any) []K {
	keys := make([]K, 0, len(m))
	for key := range m {
		keys = append(keys, key)
	}
	sort.Slice(keys, func(i, j int) bool {
		return fmt.Sprint(keys[i]) < fmt.Sprint(keys[j])
	})
	return keys
}

func redisStringValue(v any) string {
	switch t := v.(type) {
	case nil:
		return ""
	case string:
		return t
	case json.Number:
		return t.String()
	default:
		return fmt.Sprint(v)
	}
}

func redisInt64Value(v any) (int64, error) {
	switch t := v.(type) {
	case int:
		return int64(t), nil
	case int8:
		return int64(t), nil
	case int16:
		return int64(t), nil
	case int32:
		return int64(t), nil
	case int64:
		return t, nil
	case uint:
		return int64(t), nil
	case uint8:
		return int64(t), nil
	case uint16:
		return int64(t), nil
	case uint32:
		return int64(t), nil
	case uint64:
		return int64(t), nil
	case float32:
		return int64(t), nil
	case float64:
		return int64(t), nil
	case json.Number:
		return t.Int64()
	case string:
		return strconv.ParseInt(strings.TrimSpace(t), 10, 64)
	default:
		return strconv.ParseInt(strings.TrimSpace(fmt.Sprint(v)), 10, 64)
	}
}

func redisFloat64Value(v any) (float64, error) {
	switch t := v.(type) {
	case float32:
		return float64(t), nil
	case float64:
		return t, nil
	case int:
		return float64(t), nil
	case int8:
		return float64(t), nil
	case int16:
		return float64(t), nil
	case int32:
		return float64(t), nil
	case int64:
		return float64(t), nil
	case uint:
		return float64(t), nil
	case uint8:
		return float64(t), nil
	case uint16:
		return float64(t), nil
	case uint32:
		return float64(t), nil
	case uint64:
		return float64(t), nil
	case json.Number:
		return t.Float64()
	case string:
		return strconv.ParseFloat(strings.TrimSpace(t), 64)
	default:
		return strconv.ParseFloat(strings.TrimSpace(fmt.Sprint(v)), 64)
	}
}

func redisBoolValue(v any) (bool, error) {
	switch t := v.(type) {
	case bool:
		return t, nil
	case string:
		return strconv.ParseBool(strings.TrimSpace(t))
	default:
		return strconv.ParseBool(strings.TrimSpace(fmt.Sprint(v)))
	}
}

func redisMapValues(v any) ([]any, error) {
	switch t := v.(type) {
	case nil:
		return nil, fmt.Errorf("%w: value is required", connector.ErrBadRequest)
	case map[string]any:
		keys := make([]string, 0, len(t))
		for key := range t {
			keys = append(keys, key)
		}
		sort.Strings(keys)
		values := make([]any, 0, len(keys)*2)
		for _, key := range keys {
			values = append(values, key, t[key])
		}
		return values, nil
	case map[string]string:
		keys := make([]string, 0, len(t))
		for key := range t {
			keys = append(keys, key)
		}
		sort.Strings(keys)
		values := make([]any, 0, len(keys)*2)
		for _, key := range keys {
			values = append(values, key, t[key])
		}
		return values, nil
	case []any:
		if len(t) == 0 {
			return nil, fmt.Errorf("%w: value is required", connector.ErrBadRequest)
		}
		if len(t)%2 != 0 {
			return nil, fmt.Errorf("%w: hash values must contain field/value pairs", connector.ErrBadRequest)
		}
		return t, nil
	default:
		return nil, fmt.Errorf("%w: unsupported hash value shape %T", connector.ErrBadRequest, v)
	}
}

func redisListValues(v any) ([]any, error) {
	switch t := v.(type) {
	case nil:
		return nil, fmt.Errorf("%w: value is required", connector.ErrBadRequest)
	case []any:
		if len(t) == 0 {
			return nil, fmt.Errorf("%w: value is required", connector.ErrBadRequest)
		}
		return t, nil
	case []string:
		values := make([]any, 0, len(t))
		for _, item := range t {
			values = append(values, item)
		}
		return values, nil
	default:
		return []any{t}, nil
	}
}

func redisSetMembers(v any) ([]any, error) {
	switch t := v.(type) {
	case nil:
		return nil, fmt.Errorf("%w: value is required", connector.ErrBadRequest)
	case []any:
		if len(t) == 0 {
			return nil, fmt.Errorf("%w: value is required", connector.ErrBadRequest)
		}
		return t, nil
	case []string:
		values := make([]any, 0, len(t))
		for _, item := range t {
			values = append(values, item)
		}
		return values, nil
	default:
		return []any{t}, nil
	}
}

func redisZSetMembers(v any) ([]any, error) {
	switch t := v.(type) {
	case nil:
		return nil, fmt.Errorf("%w: value is required", connector.ErrBadRequest)
	case []any:
		return redisZSetMembersFromSlice(t)
	case map[string]any:
		members := make([]any, 0, len(t))
		for member, score := range t {
			f, err := redisFloat64Value(score)
			if err != nil {
				return nil, fmt.Errorf("%w: score for %q is invalid: %v", connector.ErrBadRequest, member, err)
			}
			members = append(members, goredis.Z{Score: f, Member: member})
		}
		sort.Slice(members, func(i, j int) bool {
			left := members[i].(goredis.Z)
			right := members[j].(goredis.Z)
			if left.Score == right.Score {
				return fmt.Sprint(left.Member) < fmt.Sprint(right.Member)
			}
			return left.Score < right.Score
		})
		return members, nil
	default:
		return nil, fmt.Errorf("%w: unsupported sorted set value shape %T", connector.ErrBadRequest, v)
	}
}

func redisZSetMembersFromSlice(values []any) ([]any, error) {
	if len(values) == 0 {
		return nil, fmt.Errorf("%w: value is required", connector.ErrBadRequest)
	}

	members := make([]any, 0, len(values))
	for _, item := range values {
		switch t := item.(type) {
		case map[string]any:
			member, ok := t["member"]
			if !ok {
				member, ok = t["value"]
			}
			if !ok {
				return nil, fmt.Errorf("%w: sorted set member is required", connector.ErrBadRequest)
			}
			score, ok := t["score"]
			if !ok {
				return nil, fmt.Errorf("%w: sorted set score is required", connector.ErrBadRequest)
			}
			f, err := redisFloat64Value(score)
			if err != nil {
				return nil, fmt.Errorf("%w: invalid sorted set score: %v", connector.ErrBadRequest, err)
			}
			members = append(members, goredis.Z{Score: f, Member: member})
		case goredis.Z:
			members = append(members, t)
		default:
			return nil, fmt.Errorf("%w: unsupported sorted set member shape %T", connector.ErrBadRequest, item)
		}
	}

	return members, nil
}

func redisTTLFromData(data map[string]any) (*int64, bool, error) {
	raw, ok := data["ttl"]
	if !ok {
		return nil, false, nil
	}

	ttl, err := redisInt64Value(raw)
	if err != nil {
		return nil, false, fmt.Errorf("%w: ttl must be an integer", connector.ErrBadRequest)
	}
	return &ttl, true, nil
}

func redisRenameFromData(data map[string]any) (string, bool) {
	raw, ok := data["rename"]
	if !ok {
		return "", false
	}
	rename := strings.TrimSpace(redisStringValue(raw))
	return rename, rename != ""
}

func redisCreateType(data map[string]any) string {
	createType := strings.ToLower(strings.TrimSpace(redisStringValue(data["type"])))
	return strings.TrimPrefix(createType, "redis_")
}

func redisStringSlice(values []any) []string {
	items := make([]string, 0, len(values))
	for _, value := range values {
		items = append(items, redisStringValue(value))
	}
	return items
}

func redisFilterValue(filters []connector.FilterExpr, name string) string {
	for _, filter := range filters {
		if strings.EqualFold(strings.TrimSpace(filter.Column), name) {
			return strings.TrimSpace(filter.Value)
		}
	}
	return ""
}

// redisContainsPattern turns a contains/like filter into a server-side MATCH
// glob so HSCAN/SSCAN filter inside Redis instead of shipping every element.
// Glob matching is case-sensitive, which is the native Redis behavior.
func redisContainsPattern(filters []connector.FilterExpr, column string) string {
	for _, filter := range filters {
		if !strings.EqualFold(strings.TrimSpace(filter.Column), column) {
			continue
		}
		if filter.Op != "contains" && filter.Op != "like" {
			continue
		}
		needle := strings.TrimSpace(filter.Value)
		if needle != "" {
			return "*" + escapeRedisGlob(needle) + "*"
		}
	}
	return ""
}

func escapeRedisGlob(value string) string {
	var b strings.Builder
	for _, r := range value {
		switch r {
		case '*', '?', '[', ']', '\\':
			b.WriteRune('\\')
		}
		b.WriteRune(r)
	}
	return b.String()
}

func redisEncodeJSONValue(value any) (string, error) {
	encoded, err := json.Marshal(value)
	if err != nil {
		return "", fmt.Errorf("%w: invalid json value: %v", connector.ErrBadRequest, err)
	}
	return string(encoded), nil
}

func streamTimestampFromID(id string) time.Time {
	msPart, _, ok := strings.Cut(id, "-")
	if !ok {
		return time.Time{}
	}
	ms, err := strconv.ParseInt(msPart, 10, 64)
	if err != nil {
		return time.Time{}
	}
	return time.UnixMilli(ms).UTC()
}
