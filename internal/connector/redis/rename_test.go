package redis

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/zxchlorka/kizuna/internal/connector"
)

func TestRenameKeyTo(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name       string
		from       string
		to         string
		nxResult   bool
		nxErr      error
		doErr      error
		wantErr    string
		wantIs     error
		wantCopied bool
	}{
		{
			name:     "renames within a slot",
			from:     "profile:1",
			to:       "profile:2",
			nxResult: true,
		},
		{
			name:     "refuses to overwrite an existing key",
			from:     "profile:1",
			to:       "profile:2",
			nxResult: false,
			wantErr:  "already exists",
			wantIs:   connector.ErrBadRequest,
		},
		{
			name:    "empty target",
			from:    "profile:1",
			to:      "",
			wantErr: "required",
			wantIs:  connector.ErrBadRequest,
		},
		{
			name:    "same name",
			from:    "profile:1",
			to:      "profile:1",
			wantErr: "must differ",
			wantIs:  connector.ErrBadRequest,
		},
		{
			name:    "missing source",
			from:    "gone",
			to:      "profile:2",
			nxErr:   errors.New("ERR no such key"),
			wantErr: "not found",
			wantIs:  connector.ErrRelationNotFound,
		},
		{
			// The point of the fallback: a cluster refuses a rename across hash
			// slots, so the key travels by DUMP/RESTORE instead. The copy is
			// reached here rather than completed — the fake fails the DUMP, and
			// that error surfacing proves which path was taken.
			name:       "a cross-slot rename falls back to copying",
			from:       "profile:1",
			to:         "other:2",
			nxErr:      errors.New("CROSSSLOT Keys in request don't hash to the same slot"),
			doErr:      errors.New("dump refused by the fake"),
			wantErr:    "dump refused by the fake",
			wantCopied: true,
		},
		{
			name:    "an unrelated error is reported as itself",
			from:    "profile:1",
			to:      "profile:2",
			nxErr:   errors.New("READONLY You can't write against a read only replica"),
			wantErr: "READONLY",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()

			fake := &fakeRedisClient{renameNXResult: tt.nxResult, renameNXErr: tt.nxErr, doErr: tt.doErr}
			conn := newTestRedisConnectorWithClient(fake)

			err := conn.renameKeyTo(context.Background(), tt.from, tt.to)
			if tt.wantErr == "" {
				if err != nil {
					t.Fatalf("unexpected error: %v", err)
				}
				if fake.renameNXFrom != tt.from || fake.renameNXTo != tt.to {
					t.Fatalf("renamed %q -> %q, want %q -> %q", fake.renameNXFrom, fake.renameNXTo, tt.from, tt.to)
				}
				return
			}

			if err == nil {
				t.Fatal("expected an error")
			}
			if !strings.Contains(err.Error(), tt.wantErr) {
				t.Fatalf("error %q does not mention %q", err, tt.wantErr)
			}
			if tt.wantIs != nil && !errors.Is(err, tt.wantIs) {
				t.Fatalf("error %q is not %v", err, tt.wantIs)
			}
		})
	}
}
