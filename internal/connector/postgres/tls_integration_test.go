package postgres

import (
	"context"
	"os"
	"os/exec"
	"strings"
	"testing"
	"time"

	"github.com/zxchlorka/kizuna/internal/config"
)

// Gated integration test for TLS. A unit test can prove the material lands on
// the right tls.Config, but only a real server proves the modes mean what they
// say: that verify-full rejects a certificate it cannot chain, that it rejects
// a name the certificate was not issued for, and that the connection is
// actually encrypted rather than quietly falling back.
//
// Skipped unless POSTGRES_TLS_TEST=1. When set, it ONLY ever targets the local
// docker-compose.test.yml postgres-tls service (127.0.0.1:55433, dev/dev/devdb)
// -- host, port and credentials are hardcoded to that fixture and never read
// from the environment, so this can never reach a real database (see CLAUDE.md:
// production connections are never to be used for testing).
const (
	tlsTestHost      = "127.0.0.1"
	tlsTestPort      = 55433
	tlsTestContainer = "kizuna-postgres-tls-1"
)

func tlsTestCA(t *testing.T) string {
	t.Helper()
	if os.Getenv("POSTGRES_TLS_TEST") != "1" {
		t.Skip("set POSTGRES_TLS_TEST=1 with docker-compose.test.yml's postgres-tls service running to exercise this")
	}

	// The CA lives in the fixture's volume, not on the host.
	out, err := exec.Command("docker", "exec", tlsTestContainer, "cat", "/certs/ca.crt").Output()
	if err != nil {
		t.Skipf("cannot read the fixture CA from %s: %v", tlsTestContainer, err)
	}
	return string(out)
}

func tlsTestConfig(ssl config.PostgresConfig) config.ConnectionConfig {
	return config.ConnectionConfig{
		ID:             "tls-test",
		Type:           "postgres",
		Host:           tlsTestHost,
		Port:           tlsTestPort,
		Database:       "devdb",
		Username:       "dev",
		Password:       "dev",
		PostgresConfig: &ssl,
	}
}

func TestPostgresTLSModes(t *testing.T) {
	caPEM := tlsTestCA(t)

	tests := []struct {
		name      string
		ssl       config.PostgresConfig
		wantErr   string
		wantEnc   bool
		wantNoEnc bool
	}{
		{
			name:      "disable stays in the clear",
			ssl:       config.PostgresConfig{SSLMode: config.PostgresSSLDisable},
			wantNoEnc: true,
		},
		{
			name:    "prefer takes the TLS the server offers",
			ssl:     config.PostgresConfig{SSLMode: config.PostgresSSLPrefer},
			wantEnc: true,
		},
		{
			name:    "require encrypts without checking anything",
			ssl:     config.PostgresConfig{SSLMode: config.PostgresSSLRequire},
			wantEnc: true,
		},
		{
			name:    "require with the CA verifies the chain",
			ssl:     config.PostgresConfig{SSLMode: config.PostgresSSLRequire, SSLRootCert: caPEM},
			wantEnc: true,
		},
		{
			name:    "verify-full without the CA is refused",
			ssl:     config.PostgresConfig{SSLMode: config.PostgresSSLVerifyFull},
			wantErr: "certificate",
		},
		{
			name:    "verify-full with the CA connects",
			ssl:     config.PostgresConfig{SSLMode: config.PostgresSSLVerifyFull, SSLRootCert: caPEM},
			wantEnc: true,
		},
		{
			name:    "verify-full checks the name it was given",
			ssl:     config.PostgresConfig{SSLMode: config.PostgresSSLVerifyFull, SSLRootCert: caPEM, SSLServerName: "not-in-the-cert.example"},
			wantErr: "not-in-the-cert.example",
		},
		{
			name:    "verify-ca ignores the name",
			ssl:     config.PostgresConfig{SSLMode: config.PostgresSSLVerifyCA, SSLRootCert: caPEM, SSLServerName: "not-in-the-cert.example"},
			wantEnc: true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()

			conn, err := New(ctx, tlsTestConfig(tt.ssl), "")
			if tt.wantErr != "" {
				if err == nil {
					conn.Close()
					t.Fatalf("expected the connection to be refused")
				}
				if !strings.Contains(err.Error(), tt.wantErr) {
					t.Fatalf("error %q does not mention %q", err, tt.wantErr)
				}
				return
			}
			if err != nil {
				t.Fatalf("connect: %v", err)
			}
			defer conn.Close()

			var encrypted bool
			row := conn.pool.QueryRow(ctx, "SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()")
			if err := row.Scan(&encrypted); err != nil {
				t.Fatalf("read pg_stat_ssl: %v", err)
			}
			if tt.wantEnc && !encrypted {
				t.Error("connection is not encrypted")
			}
			if tt.wantNoEnc && encrypted {
				t.Error("connection is encrypted but the mode was disable")
			}
		})
	}
}
