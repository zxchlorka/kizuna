package postgres

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/url"
	"os"
	"strconv"
	"sync"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
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

// sslSettings returns the connection's TLS settings with defaults applied,
// tolerating the nil config every connection stored before TLS support has.
func sslSettings(cfg config.ConnectionConfig) config.PostgresConfig {
	settings := config.PostgresConfig{}
	if cfg.PostgresConfig != nil {
		settings = *cfg.PostgresConfig
	}
	return settings.Normalize()
}

func decryptSecret(encKey, value string) (string, error) {
	if encKey == "" || value == "" {
		return value, nil
	}
	return config.Decrypt(encKey, value)
}

// dsnSSLMode is the mode handed to pgx, which is not always the mode the user
// picked. libpq documents that sslmode=require with a root certificate present
// verifies the chain, exactly as verify-ca does. pgx implements that rule by
// looking at the sslrootcert *setting*, which we never set — our CA arrives as
// inline PEM and is installed after parsing — so the upgrade is applied here
// instead. Without it, supplying a CA and choosing require would verify nothing.
func dsnSSLMode(ssl config.PostgresConfig) config.PostgresSSLMode {
	if ssl.SSLMode == config.PostgresSSLRequire && ssl.SSLRootCert != "" {
		return config.PostgresSSLVerifyCA
	}
	return ssl.SSLMode
}

// buildDSN assembles the connection URI. url.URL escapes the credentials, which
// fmt.Sprintf did not: a password containing @, / or ? made the DSN parse as a
// different host, or fail outright.
func buildDSN(cfg config.ConnectionConfig, password string, ssl config.PostgresConfig) string {
	dsn := url.URL{
		Scheme:   "postgres",
		User:     url.UserPassword(cfg.Username, password),
		Host:     net.JoinHostPort(resolveHost(cfg.Host), strconv.Itoa(cfg.Port)),
		Path:     "/" + cfg.Database,
		RawQuery: url.Values{"sslmode": {string(dsnSSLMode(ssl))}}.Encode(),
	}
	return dsn.String()
}

// applyTLSMaterial installs the certificate material pgx cannot take from a
// DSN. pgx reads sslrootcert/sslcert/sslkey as paths to files on disk; we hold
// PEM inline, so the config is parsed first — that is what decides each mode's
// verification rules — and the material is filled in afterwards.
//
// Every TLS config the parse produced is covered, not only the first one:
// sslmode=prefer becomes two connection attempts, one with TLS and a plaintext
// fallback, and pgx keeps the remainder in Fallbacks. Filling in only
// ConnConfig.TLSConfig would leave a fallback attempt without the CA.
func applyTLSMaterial(connCfg *pgconn.Config, ssl config.PostgresConfig, clientKey string) error {
	var rootCAs *x509.CertPool
	if ssl.SSLRootCert != "" {
		rootCAs = x509.NewCertPool()
		if !rootCAs.AppendCertsFromPEM([]byte(ssl.SSLRootCert)) {
			return errors.New("ssl root certificate is not valid PEM")
		}
	}

	var clientCerts []tls.Certificate
	switch {
	case ssl.SSLClientCert != "" && clientKey == "":
		return errors.New("ssl client certificate needs its private key")
	case ssl.SSLClientCert == "" && clientKey != "":
		return errors.New("ssl client key needs its certificate")
	case ssl.SSLClientCert != "":
		pair, err := tls.X509KeyPair([]byte(ssl.SSLClientCert), []byte(clientKey))
		if err != nil {
			return fmt.Errorf("ssl client certificate and key do not load: %w", err)
		}
		clientCerts = []tls.Certificate{pair}
	}

	tlsConfigs := make([]*tls.Config, 0, len(connCfg.Fallbacks)+1)
	if connCfg.TLSConfig != nil {
		tlsConfigs = append(tlsConfigs, connCfg.TLSConfig)
	}
	for _, fallback := range connCfg.Fallbacks {
		if fallback.TLSConfig != nil {
			tlsConfigs = append(tlsConfigs, fallback.TLSConfig)
		}
	}

	for _, tlsConfig := range tlsConfigs {
		if rootCAs != nil {
			// verify-ca verifies the chain inside a VerifyPeerCertificate closure
			// that reads RootCAs off this same struct when the handshake runs, so
			// assigning it here reaches that path too.
			tlsConfig.RootCAs = rootCAs
		}
		if clientCerts != nil {
			tlsConfig.Certificates = clientCerts
		}
		if ssl.SSLServerName != "" {
			tlsConfig.ServerName = ssl.SSLServerName
		}
	}

	return nil
}

// New creates a new PostgresConnector with a pgxpool connection pool.
func New(ctx context.Context, cfg config.ConnectionConfig, encKey string) (*PostgresConnector, error) {
	password, err := decryptSecret(encKey, cfg.Password)
	if err != nil {
		return nil, fmt.Errorf("failed to decrypt password: %w", err)
	}

	ssl := sslSettings(cfg)
	clientKey, err := decryptSecret(encKey, ssl.SSLClientKey)
	if err != nil {
		return nil, fmt.Errorf("failed to decrypt ssl client key: %w", err)
	}

	poolConfig, err := pgxpool.ParseConfig(buildDSN(cfg, password, ssl))
	if err != nil {
		return nil, normalizePostgresError(fmt.Errorf("failed to parse connection config: %w", err))
	}
	if err := applyTLSMaterial(&poolConfig.ConnConfig.Config, ssl, clientKey); err != nil {
		return nil, normalizePostgresError(err)
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
