package config

import "strings"

// PostgresSSLMode mirrors libpq's sslmode values. The names are libpq's on
// purpose: this is the setting users already know from connection strings and
// cloud consoles, and inventing our own vocabulary for it would only mean
// translating it back in every error message.
type PostgresSSLMode string

const (
	PostgresSSLDisable    PostgresSSLMode = "disable"
	PostgresSSLPrefer     PostgresSSLMode = "prefer"
	PostgresSSLRequire    PostgresSSLMode = "require"
	PostgresSSLVerifyCA   PostgresSSLMode = "verify-ca"
	PostgresSSLVerifyFull PostgresSSLMode = "verify-full"
)

// PostgresConfig stores PostgreSQL-specific connection settings.
//
// Certificate material is held inline as PEM rather than as file paths: the
// config is a single JSON file that users move between machines and mount into
// a container, and a path recorded on one host means nothing on the next.
// SSLClientKey is a private key and is encrypted at rest exactly like Password.
type PostgresConfig struct {
	SSLMode       PostgresSSLMode `json:"ssl_mode,omitempty"`
	SSLRootCert   string          `json:"ssl_root_cert,omitempty"`
	SSLClientCert string          `json:"ssl_client_cert,omitempty"`
	SSLClientKey  string          `json:"ssl_client_key,omitempty"` // encrypted
	SSLServerName string          `json:"ssl_server_name,omitempty"`
}

// Clone returns a deep copy of the Postgres config.
func (p *PostgresConfig) Clone() *PostgresConfig {
	if p == nil {
		return nil
	}
	clone := *p
	return &clone
}

// Normalize trims the PEM fields and fills in the default mode without mutating
// the receiver.
//
// The default is "disable", not libpq's "prefer", because every connection
// stored before this setting existed connected without TLS. Reading an absent
// mode as "prefer" would quietly change how those connect on the next restart.
// New connections get their default from the wizard, which sends "prefer".
func (p PostgresConfig) Normalize() PostgresConfig {
	clone := p
	clone.SSLMode = PostgresSSLMode(strings.TrimSpace(string(p.SSLMode)))
	if clone.SSLMode == "" {
		clone.SSLMode = PostgresSSLDisable
	}
	clone.SSLRootCert = strings.TrimSpace(p.SSLRootCert)
	clone.SSLClientCert = strings.TrimSpace(p.SSLClientCert)
	clone.SSLClientKey = strings.TrimSpace(p.SSLClientKey)
	clone.SSLServerName = strings.TrimSpace(p.SSLServerName)
	return clone
}

// ValidSSLMode reports whether mode is one this build understands. An empty
// mode is valid and means the default.
func ValidSSLMode(mode PostgresSSLMode) bool {
	switch mode {
	case "", PostgresSSLDisable, PostgresSSLPrefer, PostgresSSLRequire, PostgresSSLVerifyCA, PostgresSSLVerifyFull:
		return true
	}
	return false
}
