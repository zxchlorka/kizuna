package postgres

import (
	"testing"

	"github.com/zxchlorka/kizuna/internal/connector"
)

func TestBuildSQLCatalog(t *testing.T) {
	t.Parallel()

	rows := []catalogRow{
		{schema: "cch", table: "office", column: "id", dataType: "integer"},
		{schema: "cch", table: "office", column: "name", dataType: "text"},
		{schema: "cch", table: "allocation", column: "office_id", dataType: "integer"},
		{schema: "public", table: "users", column: "id", dataType: "bigint"},
	}

	catalog := buildSQLCatalog(rows, "public", 100)

	if catalog.Truncated {
		t.Fatalf("expected catalog not to be truncated")
	}
	if catalog.DefaultSchema != "public" {
		t.Fatalf("unexpected default schema: %q", catalog.DefaultSchema)
	}
	if len(catalog.Schemas) != 2 {
		t.Fatalf("unexpected schema count: %d", len(catalog.Schemas))
	}

	office := catalog.Schemas["cch"]["office"]
	want := []connector.SQLCatalogColumn{{Name: "id", Type: "integer"}, {Name: "name", Type: "text"}}
	if len(office) != len(want) {
		t.Fatalf("unexpected office columns: %+v", office)
	}
	for i := range want {
		if office[i] != want[i] {
			t.Fatalf("column %d: got %+v want %+v", i, office[i], want[i])
		}
	}
	if len(catalog.Schemas["cch"]["allocation"]) != 1 {
		t.Fatalf("unexpected allocation columns: %+v", catalog.Schemas["cch"]["allocation"])
	}
}

func TestBuildSQLCatalogTruncates(t *testing.T) {
	t.Parallel()

	rows := []catalogRow{
		{schema: "s", table: "a", column: "c1", dataType: "text"},
		{schema: "s", table: "a", column: "c2", dataType: "text"},
		{schema: "s", table: "b", column: "c3", dataType: "text"},
	}

	catalog := buildSQLCatalog(rows, "public", 2)

	if !catalog.Truncated {
		t.Fatalf("expected truncated catalog")
	}
	total := 0
	for _, tables := range catalog.Schemas {
		for _, columns := range tables {
			total += len(columns)
		}
	}
	if total != 2 {
		t.Fatalf("expected 2 columns after truncation, got %d", total)
	}
}
