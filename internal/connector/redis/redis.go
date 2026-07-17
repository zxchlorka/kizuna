package redis

import (
	"context"
	"crypto/tls"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"os"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	goredis "github.com/redis/go-redis/v9"
	"github.com/zxchlorka/kizuna/internal/config"
	"github.com/zxchlorka/kizuna/internal/connector"
)

type redisClient interface {
	Ping(ctx context.Context) *goredis.StatusCmd
	Info(ctx context.Context, sections ...string) *goredis.StringCmd
	Close() error
	Type(ctx context.Context, key string) *goredis.StatusCmd
	Do(ctx context.Context, args ...any) *goredis.Cmd
	Pipelined(ctx context.Context, fn func(goredis.Pipeliner) error) ([]goredis.Cmder, error)
	TTL(ctx context.Context, key string) *goredis.DurationCmd
	Get(ctx context.Context, key string) *goredis.StringCmd
	Set(ctx context.Context, key string, value any, expiration time.Duration) *goredis.StatusCmd
	SetArgs(ctx context.Context, key string, value any, a goredis.SetArgs) *goredis.StatusCmd
	Del(ctx context.Context, keys ...string) *goredis.IntCmd
	Scan(ctx context.Context, cursor uint64, match string, count int64) *goredis.ScanCmd
	Exists(ctx context.Context, keys ...string) *goredis.IntCmd
	Rename(ctx context.Context, key, newKey string) *goredis.StatusCmd
	Expire(ctx context.Context, key string, expiration time.Duration) *goredis.BoolCmd
	Persist(ctx context.Context, key string) *goredis.BoolCmd
	HGetAll(ctx context.Context, key string) *goredis.MapStringStringCmd
	HScan(ctx context.Context, key string, cursor uint64, match string, count int64) *goredis.ScanCmd
	HLen(ctx context.Context, key string) *goredis.IntCmd
	HSet(ctx context.Context, key string, values ...any) *goredis.IntCmd
	HDel(ctx context.Context, key string, fields ...string) *goredis.IntCmd
	LLen(ctx context.Context, key string) *goredis.IntCmd
	LRange(ctx context.Context, key string, start, stop int64) *goredis.StringSliceCmd
	LSet(ctx context.Context, key string, index int64, value any) *goredis.StatusCmd
	LPush(ctx context.Context, key string, values ...any) *goredis.IntCmd
	RPush(ctx context.Context, key string, values ...any) *goredis.IntCmd
	LRem(ctx context.Context, key string, count int64, value any) *goredis.IntCmd
	SCard(ctx context.Context, key string) *goredis.IntCmd
	SScan(ctx context.Context, key string, cursor uint64, match string, count int64) *goredis.ScanCmd
	SAdd(ctx context.Context, key string, members ...any) *goredis.IntCmd
	SRem(ctx context.Context, key string, members ...any) *goredis.IntCmd
	ZCard(ctx context.Context, key string) *goredis.IntCmd
	ZRangeWithScores(ctx context.Context, key string, start, stop int64) *goredis.ZSliceCmd
	ZRevRangeWithScores(ctx context.Context, key string, start, stop int64) *goredis.ZSliceCmd
	ZAdd(ctx context.Context, key string, members ...goredis.Z) *goredis.IntCmd
	ZRem(ctx context.Context, key string, members ...any) *goredis.IntCmd
	XRangeN(ctx context.Context, stream, start, stop string, count int64) *goredis.XMessageSliceCmd
	XRevRangeN(ctx context.Context, stream, start, stop string, count int64) *goredis.XMessageSliceCmd
	XLen(ctx context.Context, key string) *goredis.IntCmd
	XInfoGroups(ctx context.Context, key string) *goredis.XInfoGroupsCmd
}

type redisScanClient interface {
	Scan(ctx context.Context, cursor uint64, match string, count int64) *goredis.ScanCmd
}

// clusterTopology exposes the cluster master nodes and per-node clients so the
// key tree can be scanned node-by-node with resumable cursors.
type clusterTopology interface {
	Masters(ctx context.Context) ([]string, error)
	NodeScanClient(addr string) (redisScanClient, error)
	Close() error
}

type RedisConnector struct {
	client   redisClient
	topology clusterTopology
	config   config.ConnectionConfig
	redis    redisSettings

	metaMu       sync.RWMutex
	keyMetaCache map[string]redisKeyMetaBucket
}

type redisKeyMeta struct {
	keyType string
	ttl     int64
	length  *int64
}

type redisKeyMetaBucket struct {
	meta    redisKeyMeta
	expires time.Time
}

type redisSettings struct {
	mode          config.RedisMode
	address       string
	addresses     []string
	sentinelAddrs []string
	masterName    string
	separator     string
	database      int
	username      string
	tlsConfig     *tls.Config
}

// New creates a RedisConnector for standalone, cluster, or sentinel mode.
func New(ctx context.Context, cfg config.ConnectionConfig, encKey string) (*RedisConnector, error) {
	settings, err := resolveRedisSettings(cfg)
	if err != nil {
		return nil, err
	}

	password, err := decryptPassword(encKey, cfg.Password)
	if err != nil {
		return nil, fmt.Errorf("failed to decrypt password: %w", err)
	}

	client, topology, err := newRedisClient(settings, password)
	if err != nil {
		return nil, err
	}

	conn := &RedisConnector{
		client:       client,
		topology:     topology,
		config:       cfg,
		redis:        settings,
		keyMetaCache: make(map[string]redisKeyMetaBucket),
	}

	if err := conn.Ping(ctx); err != nil {
		if topology != nil {
			_ = topology.Close()
		}
		_ = client.Close()
		return nil, fmt.Errorf("failed to ping redis: %w", err)
	}

	slog.Info("redis connector created",
		"mode", string(settings.mode),
		"address", settings.address,
		"addresses", settings.addresses,
		"master_name", settings.masterName,
	)

	return conn, nil
}

func newRedisConnector(client redisClient, topology clusterTopology, cfg config.ConnectionConfig, settings redisSettings) *RedisConnector {
	return &RedisConnector{
		client:       client,
		topology:     topology,
		config:       cfg,
		redis:        settings,
		keyMetaCache: make(map[string]redisKeyMetaBucket),
	}
}

func (c *RedisConnector) Ping(ctx context.Context) error {
	return normalizeRedisError(c.client.Ping(ctx).Err())
}

func (c *RedisConnector) Execute(ctx context.Context, command string) (*connector.ExecResult, error) {
	return c.executeCommand(ctx, command)
}

func (c *RedisConnector) ExecuteBatch(ctx context.Context, commands []string) ([]connector.ExecResult, error) {
	return c.executePipeline(ctx, commands)
}

func (c *RedisConnector) Explain(context.Context, string) (*connector.ExplainResult, error) {
	return nil, unsupportedRedisOperation("explain")
}

func (c *RedisConnector) Analyze(context.Context, string) (*connector.ExplainResult, error) {
	return nil, unsupportedRedisOperation("analyze")
}

func (c *RedisConnector) Completions(ctx context.Context, req connector.CompletionRequest) ([]connector.CompletionItem, error) {
	return c.redisCompletions(ctx, req)
}

func (c *RedisConnector) MutateBulk(ctx context.Context, op connector.BulkMutateOp) (*connector.BulkMutateResult, error) {
	return c.mutateBulk(ctx, op)
}

func (c *RedisConnector) GetInfo(ctx context.Context) (*connector.ConnInfo, error) {
	info, err := c.client.Info(ctx).Result()
	if err != nil {
		return nil, fmt.Errorf("failed to get redis info: %w", normalizeRedisError(err))
	}

	parsed := parseRedisInfo(info)
	host, port := primaryEndpoint(c.redis, c.config)
	extra := map[string]any{
		"mode":        string(c.redis.mode),
		"separator":   c.redis.separator,
		"tls_enabled": c.redis.tlsConfig != nil,
		"master_name": c.redis.masterName,
	}

	for _, key := range []string{"redis_version", "uptime_in_seconds", "connected_clients", "role"} {
		if value, ok := parsed[key]; ok {
			extra[key] = value
		}
	}

	if c.topology != nil {
		masters, err := c.topology.Masters(ctx)
		if err != nil {
			slog.Warn("failed to discover redis cluster masters", "error", err)
		} else {
			extra["cluster_masters"] = masters
		}
	}

	database := strconv.Itoa(c.redis.database)
	if c.redis.mode == config.RedisModeCluster {
		database = ""
	}

	return &connector.ConnInfo{
		Version:  parsed["redis_version"],
		Database: database,
		Host:     host,
		Port:     port,
		Extra:    extra,
	}, nil
}

func (c *RedisConnector) Close() error {
	var firstErr error
	if c.topology != nil {
		if err := c.topology.Close(); err != nil {
			firstErr = err
		}
	}
	if c.client != nil {
		if err := c.client.Close(); err != nil && firstErr == nil {
			firstErr = err
		}
	}
	return firstErr
}

// NewFactory returns a ConnectorFactory for Redis.
func NewFactory() connector.ConnectorFactory {
	return func(ctx context.Context, cfg config.ConnectionConfig, encKey string) (connector.Connector, error) {
		return New(ctx, cfg, encKey)
	}
}

func resolveRedisSettings(cfg config.ConnectionConfig) (redisSettings, error) {
	redisCfg := config.RedisConfig{}
	if cfg.RedisConfig != nil {
		redisCfg = *cfg.RedisConfig
	}
	redisCfg = redisCfg.Normalize()

	settings := redisSettings{
		mode:       redisCfg.Mode,
		separator:  redisCfg.Separator,
		username:   firstNonEmpty(redisCfg.Username, cfg.Username),
		database:   redisCfg.Database,
		masterName: strings.TrimSpace(redisCfg.MasterName),
	}
	legacyDatabase := cfg.RedisConfig == nil
	if settings.mode == "" {
		settings.mode = config.RedisModeStandalone
	}

	switch settings.mode {
	case config.RedisModeStandalone:
		settings.address = resolveRedisAddress(firstNonEmpty(strings.TrimSpace(redisCfg.Address), joinHostPort(cfg.Host, cfg.Port)))
		if settings.address == "" {
			return redisSettings{}, fmt.Errorf("redis standalone mode requires an address or host/port")
		}
	case config.RedisModeCluster:
		settings.addresses = resolveRedisAddresses(redisCfg.Addresses)
		if len(settings.addresses) == 0 && strings.TrimSpace(redisCfg.Address) != "" {
			settings.addresses = resolveRedisAddresses([]string{redisCfg.Address})
		}
		if len(settings.addresses) == 0 && cfg.Host != "" {
			settings.addresses = []string{resolveRedisAddress(joinHostPort(cfg.Host, cfg.Port))}
		}
		if len(settings.addresses) == 0 {
			return redisSettings{}, fmt.Errorf("redis cluster mode requires at least one address")
		}
	case config.RedisModeSentinel:
		settings.sentinelAddrs = resolveRedisAddresses(redisCfg.SentinelAddrs)
		if len(settings.sentinelAddrs) == 0 && strings.TrimSpace(redisCfg.Address) != "" {
			settings.sentinelAddrs = resolveRedisAddresses([]string{redisCfg.Address})
		}
		if len(settings.sentinelAddrs) == 0 && cfg.Host != "" {
			settings.sentinelAddrs = []string{resolveRedisAddress(joinHostPort(cfg.Host, cfg.Port))}
		}
		if len(settings.sentinelAddrs) == 0 {
			return redisSettings{}, fmt.Errorf("redis sentinel mode requires at least one sentinel address")
		}
		if settings.masterName == "" {
			return redisSettings{}, fmt.Errorf("redis sentinel mode requires master_name")
		}
	default:
		return redisSettings{}, fmt.Errorf("unsupported redis mode %q", settings.mode)
	}

	if legacyDatabase && (settings.mode == config.RedisModeStandalone || settings.mode == config.RedisModeSentinel) {
		if settings.database == 0 && strings.TrimSpace(cfg.Database) != "" {
			db, err := strconv.Atoi(strings.TrimSpace(cfg.Database))
			if err != nil {
				return redisSettings{}, fmt.Errorf("invalid redis database %q: %w", cfg.Database, err)
			}
			settings.database = db
		}
	}

	if redisCfg.TLSEnabled {
		settings.tlsConfig = &tls.Config{MinVersion: tls.VersionTLS12}
	}

	return settings, nil
}

func unsupportedRedisOperation(name string) error {
	return fmt.Errorf("%w: redis %s is not implemented yet", connector.ErrBadRequest, name)
}

// goredisClusterTopology discovers master nodes through the cluster client and
// keeps lazily created direct clients for node-scoped scans.
type goredisClusterTopology struct {
	cluster  *goredis.ClusterClient
	settings redisSettings
	password string

	mu      sync.Mutex
	clients map[string]*goredis.Client
}

func (t *goredisClusterTopology) Masters(ctx context.Context) ([]string, error) {
	var mu sync.Mutex
	addrs := make([]string, 0, 8)

	err := t.cluster.ForEachMaster(ctx, func(_ context.Context, client *goredis.Client) error {
		mu.Lock()
		defer mu.Unlock()
		addrs = append(addrs, client.Options().Addr)
		return nil
	})
	if err != nil {
		return nil, err
	}

	// Sorted order keeps the node sequence stable so cluster scan cursors can
	// resume on the node they stopped at.
	resolved := resolveRedisAddresses(addrs)
	sort.Strings(resolved)
	return resolved, nil
}

func (t *goredisClusterTopology) NodeScanClient(addr string) (redisScanClient, error) {
	t.mu.Lock()
	defer t.mu.Unlock()

	if client, ok := t.clients[addr]; ok {
		return client, nil
	}

	client := goredis.NewClient(&goredis.Options{
		Addr:      addr,
		Username:  t.settings.username,
		Password:  t.password,
		TLSConfig: t.settings.tlsConfig,
	})
	t.clients[addr] = client
	return client, nil
}

func (t *goredisClusterTopology) Close() error {
	t.mu.Lock()
	defer t.mu.Unlock()

	var firstErr error
	for _, client := range t.clients {
		if err := client.Close(); err != nil && firstErr == nil {
			firstErr = err
		}
	}
	t.clients = make(map[string]*goredis.Client)
	return firstErr
}

func newRedisClient(settings redisSettings, password string) (redisClient, clusterTopology, error) {
	switch settings.mode {
	case config.RedisModeStandalone:
		options := &goredis.Options{
			Addr:         settings.address,
			Username:     settings.username,
			Password:     password,
			DB:           settings.database,
			TLSConfig:    settings.tlsConfig,
			DialTimeout:  0,
			ReadTimeout:  0,
			WriteTimeout: 0,
		}
		return goredis.NewClient(options), nil, nil
	case config.RedisModeCluster:
		options := &goredis.ClusterOptions{
			Addrs:        settings.addresses,
			Username:     settings.username,
			Password:     password,
			TLSConfig:    settings.tlsConfig,
			DialTimeout:  0,
			ReadTimeout:  0,
			WriteTimeout: 0,
		}
		clusterClient := goredis.NewClusterClient(options)
		topology := &goredisClusterTopology{
			cluster:  clusterClient,
			settings: settings,
			password: password,
			clients:  make(map[string]*goredis.Client),
		}
		return clusterClient, topology, nil
	case config.RedisModeSentinel:
		options := &goredis.FailoverOptions{
			MasterName:       settings.masterName,
			SentinelAddrs:    settings.sentinelAddrs,
			Username:         settings.username,
			Password:         password,
			DB:               settings.database,
			TLSConfig:        settings.tlsConfig,
			SentinelUsername: settings.username,
			SentinelPassword: password,
			DialTimeout:      0,
			ReadTimeout:      0,
			WriteTimeout:     0,
		}
		return goredis.NewFailoverClient(options), nil, nil
	default:
		return nil, nil, fmt.Errorf("unsupported redis mode %q", settings.mode)
	}
}

func decryptPassword(encKey, password string) (string, error) {
	if encKey == "" || password == "" {
		return password, nil
	}
	return config.Decrypt(encKey, password)
}

func primaryEndpoint(settings redisSettings, cfg config.ConnectionConfig) (string, string) {
	switch settings.mode {
	case config.RedisModeStandalone:
		return splitAddress(settings.address)
	case config.RedisModeCluster:
		if len(settings.addresses) > 0 {
			return splitAddress(settings.addresses[0])
		}
	case config.RedisModeSentinel:
		if len(settings.sentinelAddrs) > 0 {
			return splitAddress(settings.sentinelAddrs[0])
		}
	}
	if cfg.Host != "" {
		return cfg.Host, strconv.Itoa(portOrDefault(cfg.Port))
	}
	return "", ""
}

func parseRedisInfo(info string) map[string]string {
	parsed := make(map[string]string)
	for _, line := range strings.Split(info, "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		key, value, ok := strings.Cut(line, ":")
		if !ok {
			continue
		}
		parsed[key] = value
	}
	return parsed
}

func normalizeRedisError(err error) error {
	if err == nil {
		return nil
	}

	if errors.Is(err, goredis.Nil) {
		return fmt.Errorf("%w: %s", connector.ErrRelationNotFound, err.Error())
	}

	if errors.Is(err, context.DeadlineExceeded) || errors.Is(err, context.Canceled) {
		return fmt.Errorf("%w: %s", connector.ErrTimeout, err.Error())
	}

	var opErr *net.OpError
	if errors.As(err, &opErr) {
		return fmt.Errorf("%w: %s", connector.ErrUnavailable, err.Error())
	}

	msg := strings.ToLower(err.Error())
	switch {
	case strings.Contains(msg, "wrongpass"),
		strings.Contains(msg, "noauth"),
		strings.Contains(msg, "noperm"),
		strings.Contains(msg, "invalid username-password pair"):
		return fmt.Errorf("%w: %s", connector.ErrForbidden, err.Error())
	case strings.Contains(msg, "wrongtype"):
		return fmt.Errorf("%w: %s", connector.ErrBadRequest, err.Error())
	case strings.Contains(msg, "timeout"),
		strings.Contains(msg, "i/o timeout"):
		return fmt.Errorf("%w: %s", connector.ErrTimeout, err.Error())
	case strings.Contains(msg, "connection refused"),
		strings.Contains(msg, "failed to connect"),
		strings.Contains(msg, "connection reset"),
		strings.Contains(msg, "dial tcp"),
		strings.Contains(msg, "broken pipe"),
		strings.Contains(msg, "no such host"),
		strings.Contains(msg, "network is unreachable"):
		return fmt.Errorf("%w: %s", connector.ErrUnavailable, err.Error())
	default:
		return err
	}
}

func resolveRedisAddresses(addresses []string) []string {
	if len(addresses) == 0 {
		return nil
	}

	seen := make(map[string]struct{}, len(addresses))
	out := make([]string, 0, len(addresses))
	for _, addr := range addresses {
		addr = resolveRedisAddress(strings.TrimSpace(addr))
		if addr == "" {
			continue
		}
		if _, ok := seen[addr]; ok {
			continue
		}
		seen[addr] = struct{}{}
		out = append(out, addr)
	}
	return out
}

func resolveRedisAddress(addr string) string {
	if addr == "" {
		return ""
	}

	host, port, err := net.SplitHostPort(addr)
	if err != nil {
		return addr
	}

	return net.JoinHostPort(resolveHost(host), port)
}

func resolveHost(host string) string {
	return resolveHostWithLookup(host, isRunningInDocker(), net.LookupHost)
}

func resolveHostWithLookup(host string, inDocker bool, lookup func(string) ([]string, error)) string {
	if host != "localhost" && host != "127.0.0.1" {
		return host
	}
	if !inDocker {
		return host
	}

	if gateway := resolveDockerGatewayHost(lookup); gateway != "" {
		return gateway
	}

	return "host.docker.internal"
}

func isRunningInDocker() bool {
	_, err := os.Stat("/.dockerenv")
	return err == nil
}

func resolveDockerGatewayHost(lookup func(string) ([]string, error)) string {
	if lookup == nil {
		return ""
	}

	addrs, err := lookup("host.docker.internal")
	if err != nil {
		return ""
	}

	for _, addr := range addrs {
		ip := net.ParseIP(strings.TrimSpace(addr))
		if ip == nil || ip.IsLoopback() {
			continue
		}
		return ip.String()
	}

	return ""
}

func splitAddress(addr string) (string, string) {
	host, port, err := net.SplitHostPort(addr)
	if err != nil {
		return addr, ""
	}
	return host, port
}

func joinHostPort(host string, port int) string {
	if host == "" {
		return ""
	}
	return net.JoinHostPort(host, strconv.Itoa(portOrDefault(port)))
}

func portOrDefault(port int) int {
	if port > 0 {
		return port
	}
	return 6379
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if trimmed := strings.TrimSpace(value); trimmed != "" {
			return trimmed
		}
	}
	return ""
}
