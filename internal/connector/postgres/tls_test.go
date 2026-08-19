package postgres

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"math/big"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/zxchlorka/kizuna/internal/config"
)

func TestBuildDSN(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name     string
		conn     config.ConnectionConfig
		password string
		ssl      config.PostgresConfig
		want     string
	}{
		{
			name:     "plain",
			conn:     config.ConnectionConfig{Host: "db.example", Port: 5432, Database: "app", Username: "reader"},
			password: "secret",
			ssl:      config.PostgresConfig{SSLMode: config.PostgresSSLDisable},
			want:     "postgres://reader:secret@db.example:5432/app?sslmode=disable",
		},
		{
			// The old fmt.Sprintf DSN broke here: the @ ended the userinfo early and
			// pgx parsed "b" as the host.
			name:     "password with separators is escaped",
			conn:     config.ConnectionConfig{Host: "db.example", Port: 5432, Database: "app", Username: "reader"},
			password: "a@b/c?d:e",
			ssl:      config.PostgresConfig{SSLMode: config.PostgresSSLRequire},
			want:     "postgres://reader:a%40b%2Fc%3Fd%3Ae@db.example:5432/app?sslmode=require",
		},
		{
			name:     "ipv6 host is bracketed",
			conn:     config.ConnectionConfig{Host: "::1", Port: 5432, Database: "app", Username: "reader"},
			password: "p",
			ssl:      config.PostgresConfig{SSLMode: config.PostgresSSLPrefer},
			want:     "postgres://reader:p@[::1]:5432/app?sslmode=prefer",
		},
		{
			name:     "require with a CA is handed to pgx as verify-ca",
			conn:     config.ConnectionConfig{Host: "db.example", Port: 5432, Database: "app", Username: "reader"},
			password: "p",
			ssl:      config.PostgresConfig{SSLMode: config.PostgresSSLRequire, SSLRootCert: "-----BEGIN CERTIFICATE-----"},
			want:     "postgres://reader:p@db.example:5432/app?sslmode=verify-ca",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			got := buildDSN(tt.conn, tt.password, tt.ssl)
			if got != tt.want {
				t.Fatalf("dsn mismatch:\n got %s\nwant %s", got, tt.want)
			}
			if _, err := pgxpool.ParseConfig(got); err != nil {
				t.Fatalf("pgx cannot parse the dsn we build: %v", err)
			}
		})
	}
}

func TestSSLSettingsDefaultsToDisable(t *testing.T) {
	t.Parallel()

	// Every connection stored before TLS existed has no postgres_config at all,
	// and must keep connecting exactly as it did.
	got := sslSettings(config.ConnectionConfig{Host: "db", Port: 5432})
	if got.SSLMode != config.PostgresSSLDisable {
		t.Fatalf("nil config should mean disable, got %q", got.SSLMode)
	}
}

// TestApplyTLSMaterialCoversFallbacks pins the reason this code exists: sslmode
// values that imply a retry produce several connection attempts, and material
// installed on only the first one leaves the rest unverified.
func TestApplyTLSMaterialCoversFallbacks(t *testing.T) {
	t.Parallel()

	caPEM, _ := testCertificate(t)

	poolCfg, err := pgxpool.ParseConfig("postgres://u:p@db.example:5432/app?sslmode=prefer")
	if err != nil {
		t.Fatalf("parse: %v", err)
	}

	ssl := config.PostgresConfig{SSLMode: config.PostgresSSLPrefer, SSLRootCert: caPEM, SSLServerName: "real.example"}
	if err := applyTLSMaterial(&poolCfg.ConnConfig.Config, ssl, ""); err != nil {
		t.Fatalf("apply: %v", err)
	}

	checked := 0
	if poolCfg.ConnConfig.TLSConfig != nil {
		checked++
		if poolCfg.ConnConfig.TLSConfig.RootCAs == nil {
			t.Error("primary attempt has no CA pool")
		}
		if poolCfg.ConnConfig.TLSConfig.ServerName != "real.example" {
			t.Errorf("primary attempt server name = %q", poolCfg.ConnConfig.TLSConfig.ServerName)
		}
	}
	for i, fallback := range poolCfg.ConnConfig.Fallbacks {
		if fallback.TLSConfig == nil {
			continue // the plaintext attempt prefer falls back to
		}
		checked++
		if fallback.TLSConfig.RootCAs == nil {
			t.Errorf("fallback %d has no CA pool", i)
		}
	}
	if checked == 0 {
		t.Fatal("no TLS config was inspected; the test proves nothing")
	}
}

func TestApplyTLSMaterialErrors(t *testing.T) {
	t.Parallel()

	caPEM, _ := testCertificate(t)
	certPEM, keyPEM := testCertificate(t)

	tests := []struct {
		name      string
		ssl       config.PostgresConfig
		clientKey string
		wantErr   string
	}{
		{
			name:    "garbage CA",
			ssl:     config.PostgresConfig{SSLRootCert: "not a certificate"},
			wantErr: "not valid PEM",
		},
		{
			name:    "certificate without key",
			ssl:     config.PostgresConfig{SSLClientCert: certPEM},
			wantErr: "needs its private key",
		},
		{
			name:      "key without certificate",
			ssl:       config.PostgresConfig{},
			clientKey: keyPEM,
			wantErr:   "needs its certificate",
		},
		{
			name:      "mismatched pair",
			ssl:       config.PostgresConfig{SSLClientCert: caPEM},
			clientKey: keyPEM,
			wantErr:   "do not load",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			poolCfg, err := pgxpool.ParseConfig("postgres://u:p@db.example:5432/app?sslmode=require")
			if err != nil {
				t.Fatalf("parse: %v", err)
			}
			err = applyTLSMaterial(&poolCfg.ConnConfig.Config, tt.ssl, tt.clientKey)
			if err == nil {
				t.Fatal("expected an error")
			}
			if !strings.Contains(err.Error(), tt.wantErr) {
				t.Fatalf("error %q does not mention %q", err, tt.wantErr)
			}
		})
	}
}

func TestApplyTLSMaterialAcceptsAPair(t *testing.T) {
	t.Parallel()

	certPEM, keyPEM := testCertificate(t)
	poolCfg, err := pgxpool.ParseConfig("postgres://u:p@db.example:5432/app?sslmode=require")
	if err != nil {
		t.Fatalf("parse: %v", err)
	}

	ssl := config.PostgresConfig{SSLMode: config.PostgresSSLRequire, SSLClientCert: certPEM}
	if err := applyTLSMaterial(&poolCfg.ConnConfig.Config, ssl, keyPEM); err != nil {
		t.Fatalf("apply: %v", err)
	}
	if len(poolCfg.ConnConfig.TLSConfig.Certificates) != 1 {
		t.Fatalf("client certificate not installed")
	}
}

// testCertificate returns a self-signed certificate and its key, both PEM.
func testCertificate(t *testing.T) (certPEM, keyPEM string) {
	t.Helper()

	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatalf("generate key: %v", err)
	}
	template := x509.Certificate{
		SerialNumber:          big.NewInt(1),
		Subject:               pkix.Name{CommonName: "kizuna-test"},
		NotBefore:             time.Now().Add(-time.Hour),
		NotAfter:              time.Now().Add(time.Hour),
		IsCA:                  true,
		BasicConstraintsValid: true,
	}
	der, err := x509.CreateCertificate(rand.Reader, &template, &template, &key.PublicKey, key)
	if err != nil {
		t.Fatalf("create certificate: %v", err)
	}
	keyDER, err := x509.MarshalECPrivateKey(key)
	if err != nil {
		t.Fatalf("marshal key: %v", err)
	}

	return string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})),
		string(pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: keyDER}))
}
