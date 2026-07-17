package postgres

import (
	"context"
	"fmt"
	"log/slog"
	"os"
	"sync"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/zxchlorka/kizuna/internal/config"
	"github.com/zxchlorka/kizuna/internal/connector"
)

// resolveHost replaces localhost/127.0.0.1 with host.docker.internal when
// running inside a Docker container, so the backend can reach host-exposed ports.
func resolveHost(host string) string {
	if host != "localhost" && host != "127.0.0.1" {
		return host
	}
	if _, err := os.Stat("/.dockerenv"); err == nil {
		return "host.docker.internal"
	}
	return host
}

type PostgresConnector struct {
	pool   *pgxpool.Pool
	config config.ConnectionConfig

	completionMu      sync.RWMutex
	tableCache        []completionCacheItem
	tableCacheUntil   time.Time
	columnCache       map[string]completionCacheBucket
	catalogCache      *connector.SQLCatalog
	catalogCacheUntil time.Time

	objectCacheMu    sync.RWMutex
	rootObjectCache  objectCacheBucket
	childObjectCache map[string]objectCacheBucket

	schemaCacheMu sync.RWMutex
	schemaCache   map[string]schemaCacheBucket
}

type completionCacheItem struct {
	label  string
	detail string
}

type completionCacheBucket struct {
	items   []completionCacheItem
	expires time.Time
}

type objectCacheBucket struct {
	items   []connector.Object
	expires time.Time
}

type schemaCacheBucket struct {
	schema  *connector.Schema
	expires time.Time
}

// New creates a new PostgresConnector with a pgxpool connection pool.
func New(ctx context.Context, cfg config.ConnectionConfig, encKey string) (*PostgresConnector, error) {
	password := cfg.Password
	if encKey != "" && password != "" {
		decrypted, err := config.Decrypt(encKey, password)
		if err != nil {
			return nil, fmt.Errorf("failed to decrypt password: %w", err)
		}
		password = decrypted
	}

	host := resolveHost(cfg.Host)
	dsn := fmt.Sprintf("postgres://%s:%s@%s:%d/%s?sslmode=disable",
		cfg.Username, password, host, cfg.Port, cfg.Database)

	poolConfig, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		return nil, normalizePostgresError(fmt.Errorf("failed to parse connection config: %w", err))
	}
	poolConfig.ConnConfig.ConnectTimeout = 5 * time.Second

	pool, err := pgxpool.NewWithConfig(ctx, poolConfig)
	if err != nil {
		return nil, normalizePostgresError(fmt.Errorf("failed to create connection pool: %w", err))
	}

	if err := pool.Ping(ctx); err != nil {
		pool.Close()
		return nil, normalizePostgresError(fmt.Errorf("failed to ping database: %w", err))
	}

	slog.Info("postgres connector created", "host", cfg.Host, "database", cfg.Database)

	return &PostgresConnector{
		pool:             pool,
		config:           cfg,
		columnCache:      make(map[string]completionCacheBucket),
		childObjectCache: make(map[string]objectCacheBucket),
		schemaCache:      make(map[string]schemaCacheBucket),
	}, nil
}

func (p *PostgresConnector) Ping(ctx context.Context) error {
	return normalizePostgresError(p.pool.Ping(ctx))
}

func (p *PostgresConnector) GetInfo(ctx context.Context) (*connector.ConnInfo, error) {
	var version, database string
	err := p.pool.QueryRow(ctx, "SELECT version(), current_database()").Scan(&version, &database)
	if err != nil {
		return nil, normalizePostgresError(fmt.Errorf("failed to get info: %w", err))
	}

	return &connector.ConnInfo{
		Version:  version,
		Database: database,
		Host:     p.config.Host,
		Port:     fmt.Sprintf("%d", p.config.Port),
	}, nil
}

func (p *PostgresConnector) Close() error {
	p.pool.Close()
	return nil
}

// NewFactory returns a ConnectorFactory for PostgreSQL.
func NewFactory() connector.ConnectorFactory {
	return func(ctx context.Context, cfg config.ConnectionConfig, encKey string) (connector.Connector, error) {
		return New(ctx, cfg, encKey)
	}
}
