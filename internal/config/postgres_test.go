package config

import "testing"

func TestPostgresConfigNormalize(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name string
		in   PostgresConfig
		want PostgresConfig
	}{
		{
			name: "empty mode keeps existing connections plaintext",
			in:   PostgresConfig{},
			want: PostgresConfig{SSLMode: PostgresSSLDisable},
		},
		{
			name: "surrounding whitespace is trimmed off pasted PEM",
			in:   PostgresConfig{SSLMode: " require ", SSLRootCert: "\n-----BEGIN CERTIFICATE-----\n", SSLServerName: " db.internal "},
			want: PostgresConfig{SSLMode: PostgresSSLRequire, SSLRootCert: "-----BEGIN CERTIFICATE-----", SSLServerName: "db.internal"},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			got := tt.in.Normalize()
			if got != tt.want {
				t.Fatalf("got %+v want %+v", got, tt.want)
			}
		})
	}
}

func TestPostgresConfigCloneIsIndependent(t *testing.T) {
	t.Parallel()

	original := &PostgresConfig{SSLMode: PostgresSSLVerifyFull, SSLClientKey: "key"}
	clone := original.Clone()
	clone.SSLClientKey = "other"

	if original.SSLClientKey != "key" {
		t.Fatal("clone wrote through to the original")
	}
	if (*PostgresConfig)(nil).Clone() != nil {
		t.Fatal("cloning nil should stay nil")
	}
}

func TestValidSSLMode(t *testing.T) {
	t.Parallel()

	for _, mode := range []PostgresSSLMode{"", PostgresSSLDisable, PostgresSSLPrefer, PostgresSSLRequire, PostgresSSLVerifyCA, PostgresSSLVerifyFull} {
		if !ValidSSLMode(mode) {
			t.Errorf("mode %q should be valid", mode)
		}
	}
	for _, mode := range []PostgresSSLMode{"verify", "off", "TRUE"} {
		if ValidSSLMode(mode) {
			t.Errorf("mode %q should be rejected", mode)
		}
	}
}
