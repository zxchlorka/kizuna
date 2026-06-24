package postgres

import (
	"testing"

	"github.com/qsnake66/kizuna/internal/connector"
)

func TestBuildResultRow(t *testing.T) {
	t.Parallel()

	columns := []connector.ColumnMeta{
		{Name: "id"},
		{Name: "client_company"},
		{Name: "net_wip_before"},
	}

	row := buildResultRow(columns, []any{9162663, "Xeinadin South East Limited", -649.2})

	if got, want := row["id"], 9162663; got != want {
		t.Fatalf("id mismatch: got %v want %v", got, want)
	}
	if got, want := row["client_company"], "Xeinadin South East Limited"; got != want {
		t.Fatalf("client_company mismatch: got %v want %v", got, want)
	}
	if got, want := row["net_wip_before"], -649.2; got != want {
		t.Fatalf("net_wip_before mismatch: got %v want %v", got, want)
	}
}

func TestBuildResultRowFillsMissingValuesWithNil(t *testing.T) {
	t.Parallel()

	columns := []connector.ColumnMeta{
		{Name: "id"},
		{Name: "name"},
	}

	row := buildResultRow(columns, []any{42})

	if got, want := row["id"], 42; got != want {
		t.Fatalf("id mismatch: got %v want %v", got, want)
	}
	if got := row["name"]; got != nil {
		t.Fatalf("expected missing column to be nil, got %v", got)
	}
}
