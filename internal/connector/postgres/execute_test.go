package postgres

import (
	"testing"

	"github.com/jackc/pgx/v5/pgconn"
	"github.com/zxchlorka/kizuna/internal/connector"
)

func TestIsRowReturningStatement(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name      string
		statement string
		want      bool
	}{
		{name: "select", statement: "SELECT * FROM users", want: true},
		{name: "with cte", statement: "WITH t AS (SELECT 1) SELECT * FROM t", want: true},
		{name: "insert returning", statement: "INSERT INTO users(id) VALUES (1) RETURNING id", want: true},
		{name: "update no returning", statement: "UPDATE users SET name = 'a'", want: false},
		{name: "ddl", statement: "CREATE TABLE demo(id integer)", want: false},
		{name: "select empty list multiline", statement: "SELECT\nFROM cch.office\nLIMIT 10", want: true},
		{name: "select with tab", statement: "SELECT\tid FROM users", want: true},
		{name: "select star no space", statement: "select*from users", want: true},
		{name: "parenthesized select", statement: "(SELECT 1) UNION (SELECT 2)", want: true},
		{name: "table statement", statement: "TABLE users", want: true},
		{name: "values no space", statement: "VALUES(1),(2)", want: true},
		{name: "call procedure", statement: "CALL select_totals()", want: false},
		{name: "identifier prefix collision", statement: "selectivity_report()", want: false},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			if got := isRowReturningStatement(tc.statement); got != tc.want {
				t.Fatalf("unexpected classification: got %v want %v", got, tc.want)
			}
		})
	}
}

func TestIsSchemaChangingStatement(t *testing.T) {
	t.Parallel()

	tests := []struct {
		statement string
		want      bool
	}{
		{statement: "CREATE TABLE demo(id integer)", want: true},
		{statement: "ALTER TABLE demo ADD COLUMN name text", want: true},
		{statement: "DROP TABLE demo", want: true},
		{statement: "SELECT * FROM demo", want: false},
	}

	for _, tc := range tests {
		if got := isSchemaChangingStatement(tc.statement); got != tc.want {
			t.Fatalf("statement %q: got %v want %v", tc.statement, got, tc.want)
		}
	}
}

func TestColumnTypeNames(t *testing.T) {
	t.Parallel()

	got := columnTypeNames([]pgconn.FieldDescription{
		{Name: "id", DataTypeOID: 23},
		{Name: "payload", DataTypeOID: 3802},
		{Name: "mystery", DataTypeOID: 999999},
	})

	want := []string{"int4", "jsonb", "unknown"}
	if len(got) != len(want) {
		t.Fatalf("unexpected length: got %d want %d", len(got), len(want))
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("index %d: got %q want %q", i, got[i], want[i])
		}
	}
}

func TestTopLevelLimit(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name      string
		statement string
		want      limitInfo
		wantErr   bool
	}{
		{
			name:      "no limit",
			statement: "SELECT * FROM users",
			want:      limitInfo{},
		},
		{
			name:      "top level limit",
			statement: "SELECT * FROM users LIMIT 100",
			want:      limitInfo{found: true, literal: true, value: 100},
		},
		{
			name:      "nested limit ignored",
			statement: "SELECT * FROM (SELECT * FROM users LIMIT 10) u",
			want:      limitInfo{},
		},
		{
			name:      "comments and strings ignored",
			statement: "SELECT '-- limit 999' AS sample /* LIMIT 4 */ FROM users LIMIT 25",
			want:      limitInfo{found: true, literal: true, value: 25},
		},
		{
			name:      "limit all",
			statement: "SELECT * FROM users LIMIT ALL",
			want:      limitInfo{found: true, literal: true, isAll: true},
		},
		{
			name:      "non literal limit",
			statement: "SELECT * FROM users LIMIT foo",
			want:      limitInfo{found: true, literal: false},
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			got, err := topLevelLimit(tc.statement)
			if tc.wantErr {
				if err == nil {
					t.Fatalf("expected error")
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if got != tc.want {
				t.Fatalf("unexpected limit info: got %#v want %#v", got, tc.want)
			}
		})
	}
}

func TestRowFetchPolicyForStatement(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name      string
		statement string
		want      rowFetchPolicy
		wantErr   bool
	}{
		{
			name:      "default cap without limit",
			statement: "SELECT * FROM users",
			want:      rowFetchPolicy{readLimit: 501, appliedLimit: 500},
		},
		{
			name:      "respects explicit limit",
			statement: "SELECT * FROM users LIMIT 100",
			want:      rowFetchPolicy{readLimit: 100},
		},
		{
			name:      "allows limit at hard max",
			statement: "SELECT * FROM users LIMIT 500",
			want:      rowFetchPolicy{readLimit: 500},
		},
		{
			name:      "rejects limit all",
			statement: "SELECT * FROM users LIMIT ALL",
			wantErr:   true,
		},
		{
			name:      "rejects limit over hard max",
			statement: "SELECT * FROM users LIMIT 501",
			wantErr:   true,
		},
		{
			name:      "rejects non literal limit",
			statement: "SELECT * FROM users LIMIT foo",
			wantErr:   true,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			got, err := rowFetchPolicyForStatement(tc.statement)
			if tc.wantErr {
				if err == nil {
					t.Fatalf("expected error")
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if got != tc.want {
				t.Fatalf("unexpected policy: got %#v want %#v", got, tc.want)
			}
		})
	}
}

func TestBuildColumnSources(t *testing.T) {
	keys := []oidAttn{
		{oid: 100, attnum: 1},
		{oid: 0, attnum: 0},
		{oid: 100, attnum: 2},
	}
	lookup := map[oidAttn]connector.ColumnSource{
		{oid: 100, attnum: 1}: {Table: "public.users", Column: "id"},
		{oid: 100, attnum: 2}: {Table: "public.users", Column: "email"},
	}

	got := buildColumnSources(keys, lookup)
	if len(got) != 3 {
		t.Fatalf("expected 3 entries, got %d", len(got))
	}
	if got[0] == nil || got[0].Table != "public.users" || got[0].Column != "id" {
		t.Fatalf("col 0 = %#v", got[0])
	}
	if got[1] != nil {
		t.Fatalf("col 1 (expression, TableOID=0) should be nil, got %#v", got[1])
	}
	if got[2] == nil || got[2].Column != "email" {
		t.Fatalf("col 2 = %#v", got[2])
	}
	if buildColumnSources([]oidAttn{{oid: 0, attnum: 0}}, lookup) != nil {
		t.Fatalf("all-expression result should yield nil")
	}
}
