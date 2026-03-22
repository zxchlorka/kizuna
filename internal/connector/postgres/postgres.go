package postgres

import (
	"context"
	"fmt"
	"log/slog"
	"os"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/qsnake66/infraview/internal/config"
	"github.com/qsnake66/infraview/internal/connector"
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

	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		return nil, fmt.Errorf("failed to create connection pool: %w", err)
	}

	if err := pool.Ping(ctx); err != nil {
		pool.Close()
		return nil, fmt.Errorf("failed to ping database: %w", err)
	}

	slog.Info("postgres connector created", "host", cfg.Host, "database", cfg.Database)

	return &PostgresConnector{
		pool:   pool,
		config: cfg,
	}, nil
}

func (p *PostgresConnector) Ping(ctx context.Context) error {
	return p.pool.Ping(ctx)
}

func (p *PostgresConnector) GetInfo(ctx context.Context) (*connector.ConnInfo, error) {
	var version, database string
	err := p.pool.QueryRow(ctx, "SELECT version(), current_database()").Scan(&version, &database)
	if err != nil {
		return nil, fmt.Errorf("failed to get info: %w", err)
	}

	return &connector.ConnInfo{
		Version:  version,
		Database: database,
		Host:     p.config.Host,
		Port:     fmt.Sprintf("%d", p.config.Port),
	}, nil
}

func (p *PostgresConnector) GetData(ctx context.Context, object string, opts connector.DataOpts) (*connector.DataResult, error) {
	return nil, fmt.Errorf("not implemented")
}

func (p *PostgresConnector) Execute(ctx context.Context, command string) (*connector.ExecResult, error) {
	return nil, fmt.Errorf("not implemented")
}

func (p *PostgresConnector) Mutate(ctx context.Context, op connector.MutateOp) (*connector.MutateResult, error) {
	return nil, fmt.Errorf("not implemented")
}

func (p *PostgresConnector) DDL(ctx context.Context, op connector.DDLOp) error {
	return fmt.Errorf("not implemented")
}

func (p *PostgresConnector) Close() error {
	p.pool.Close()
	return nil
}

// NewFactory returns a ConnectorFactory for PostgreSQL.
func NewFactory() connector.ConnectorFactory {
	return func(cfg config.ConnectionConfig, encKey string) (connector.Connector, error) {
		return New(context.Background(), cfg, encKey)
	}
}
