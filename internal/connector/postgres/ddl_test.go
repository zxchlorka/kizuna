package postgres

import (
	"errors"
	"net"
	"testing"

	"github.com/jackc/pgx/v5/pgconn"
	"github.com/qsnake66/kizuna/internal/connector"
)

func TestBuildDDLStatementCreateTable(t *testing.T) {
	t.Parallel()

	sql, err := buildDDLStatement(connector.DDLOp{
		Type:   "create_table",
		Schema: "public",
		Object: "audit_log",
		Params: map[string]any{
			"columns": []any{
				map[string]any{
					"name":        "id",
					"type":        "uuid",
					"nullable":    false,
					"primary_key": true,
					"default":     "gen_random_uuid()",
				},
				map[string]any{
					"name":     "payload",
					"type":     "jsonb",
					"nullable": false,
				},
			},
		},
	})
	if err != nil {
		t.Fatalf("buildDDLStatement returned error: %v", err)
	}

	expected := `CREATE TABLE "public"."audit_log" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "payload" jsonb NOT NULL, PRIMARY KEY ("id"))`
	if sql != expected {
		t.Fatalf("unexpected SQL:\nwant: %s\ngot:  %s", expected, sql)
	}
}

func TestBuildDDLStatementRejectsUnsupportedType(t *testing.T) {
	t.Parallel()

	_, err := buildDDLStatement(connector.DDLOp{
		Type:   "add_column",
		Schema: "public",
		Object: "users",
		Params: map[string]any{
			"name":     "payload",
			"type":     "text; drop table users;",
			"nullable": true,
		},
	})
	if err == nil {
		t.Fatal("expected unsupported type error")
	}
}

func TestNormalizePostgresError(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name string
		err  error
		want error
	}{
		{
			name: "duplicate key -> conflict",
			err:  &pgconn.PgError{Code: "23505", Message: "duplicate key"},
			want: connector.ErrConflict,
		},
		{
			name: "permission denied -> forbidden",
			err:  &pgconn.PgError{Code: "42501", Message: "permission denied"},
			want: connector.ErrForbidden,
		},
		{
			name: "relation missing -> not found",
			err:  &pgconn.PgError{Code: "42P01", Message: "relation does not exist"},
			want: connector.ErrRelationNotFound,
		},
		{
			name: "connection refused -> unavailable",
			err:  &net.OpError{Op: "dial", Net: "tcp", Err: errors.New("connection refused")},
			want: connector.ErrUnavailable,
		},
	}

	for _, tc := range tests {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			got := normalizePostgresError(tc.err)
			if got == nil {
				t.Fatal("expected normalized error")
			}
			if got.Error() == tc.err.Error() && tc.want != nil {
				t.Fatalf("expected error to be wrapped, got %v", got)
			}
			if !containsSentinel(got, tc.want) {
				t.Fatalf("expected %v to wrap %v", got, tc.want)
			}
		})
	}
}

func containsSentinel(err error, target error) bool {
	return target != nil && err != nil && (err == target || containsSentinelUnwrap(err, target))
}

func containsSentinelUnwrap(err error, target error) bool {
	type unwrapper interface {
		Unwrap() error
	}
	current, ok := err.(unwrapper)
	if !ok {
		return false
	}
	next := current.Unwrap()
	if next == nil {
		return false
	}
	if next == target {
		return true
	}
	return containsSentinelUnwrap(next, target)
}
