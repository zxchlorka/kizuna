package postgres

import (
	"errors"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgconn"
	"github.com/zxchlorka/kizuna/internal/connector"
)

// A section that fails because of how the server is set up must say which
// setup: an empty table, or Postgres's own "relation does not exist", tells the
// reader nothing they can act on.
func TestExplainStatsError(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name    string
		section connector.ServerStatsSection
		err     error
		wantIs  error
		wantSub string
	}{
		{
			name:    "missing extension names the extension",
			section: connector.StatsStatements,
			err:     &pgconn.PgError{Code: sqlStateUndefinedTable, Message: `relation "pg_stat_statements" does not exist`},
			wantIs:  connector.ErrBadRequest,
			wantSub: "shared_preload_libraries",
		},
		{
			name:    "denied privilege names the role to grant",
			section: connector.StatsActivity,
			err:     &pgconn.PgError{Code: sqlStateInsufficientPrivilege, Message: "permission denied"},
			wantIs:  connector.ErrForbidden,
			wantSub: "pg_monitor",
		},
		{
			// Only pg_stat_statements is an extension; a missing relation in any
			// other section is a real fault and must not be dressed up as one.
			name:    "a missing relation elsewhere is not blamed on an extension",
			section: connector.StatsTables,
			err:     &pgconn.PgError{Code: sqlStateUndefinedTable, Message: `relation "nope" does not exist`},
			wantSub: "nope",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()

			got := explainStatsError(tt.section, tt.err)
			if got == nil {
				t.Fatal("expected an error")
			}
			if tt.wantIs != nil && !errors.Is(got, tt.wantIs) {
				t.Fatalf("error = %v, want one wrapping %v", got, tt.wantIs)
			}
			if !strings.Contains(got.Error(), tt.wantSub) {
				t.Fatalf("error %q does not mention %q", got, tt.wantSub)
			}
		})
	}
}

// Every declared section must have a query behind it, or the screen offers a tab
// that can only fail.
func TestEverySectionHasAQuery(t *testing.T) {
	t.Parallel()

	for _, section := range []connector.ServerStatsSection{
		connector.StatsActivity, connector.StatsStatements,
		connector.StatsTables, connector.StatsReplication,
		connector.StatsIndexes,
	} {
		query, ok := statsQueries[section]
		if !ok {
			t.Fatalf("section %q has no query", section)
		}
		if query.hint == "" {
			t.Fatalf("section %q has no hint saying what its numbers do not cover", section)
		}
	}
}
