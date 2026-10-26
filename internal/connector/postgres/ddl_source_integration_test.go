package postgres

import (
	"context"
	"errors"
	"fmt"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/zxchlorka/kizuna/internal/config"
	"github.com/zxchlorka/kizuna/internal/connector"
)

// Skipped unless POSTGRES_DDL_TEST=1. Like the cancel tests, it only ever targets
// the docker-compose.test.yml Postgres with credentials hardcoded here.
func TestObjectDDLIntegration(t *testing.T) {
	if os.Getenv("POSTGRES_DDL_TEST") != "1" {
		t.Skip("set POSTGRES_DDL_TEST=1 with docker-compose.test.yml's postgres service running to exercise this")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	p, err := New(ctx, config.ConnectionConfig{
		ID: "ddl-test", Type: "postgres", Host: "127.0.0.1", Port: 55432, Database: "devdb", Username: "dev", Password: "dev",
	}, "")
	if err != nil {
		t.Fatalf("connect to local test postgres: %v", err)
	}
	// Cleanup, not defer: the schema drops below are cleanups too and need the
	// pool open, and cleanups run after deferred calls, last-registered first.
	t.Cleanup(func() { p.Close() })

	schema := fmt.Sprintf("ddl_qa_%d", time.Now().UnixNano())
	exec := func(sql string) {
		t.Helper()
		if _, err := p.pool.Exec(ctx, sql); err != nil {
			t.Fatalf("%s: %v", sql, err)
		}
	}
	exec(`CREATE SCHEMA ` + schema)
	t.Cleanup(func() { _, _ = p.pool.Exec(context.Background(), `DROP SCHEMA `+schema+` CASCADE`) })

	exec(`CREATE TABLE ` + schema + `.accounts (id bigint PRIMARY KEY)`)
	exec(`CREATE TABLE ` + schema + `."Order Items" (
		id bigint GENERATED ALWAYS AS IDENTITY (START WITH 100 INCREMENT BY 10) PRIMARY KEY,
		account_id bigint NOT NULL REFERENCES ` + schema + `.accounts(id),
		qty int NOT NULL DEFAULT 1 CHECK (qty > 0),
		price numeric(10,2),
		total numeric GENERATED ALWAYS AS (qty * price) STORED,
		sku text UNIQUE,
		line_no serial,
		batch serial,
		plain_no serial,
		code text COLLATE "C"
	) WITH (fillfactor=70)`)
	exec(`ALTER SEQUENCE ` + schema + `."Order Items_line_no_seq" START WITH 7 RESTART`)
	// Renamed, and a raised minimum that only works together with its start.
	exec(`ALTER SEQUENCE ` + schema + `."Order Items_batch_seq" RENAME TO batch_counter`)
	exec(`ALTER SEQUENCE ` + schema + `.batch_counter START WITH 50 MINVALUE 50 RESTART`)
	exec(`CREATE INDEX order_items_account_idx ON ` + schema + `."Order Items" (account_id) WHERE qty > 1`)
	exec(`CREATE VIEW ` + schema + `.big_orders WITH (security_invoker=true) AS SELECT id, qty FROM ` + schema + `."Order Items" WHERE qty > 10 WITH CASCADED CHECK OPTION`)
	exec(`CREATE TABLE ` + schema + `.events (at date NOT NULL) PARTITION BY RANGE (at)`)

	tests := []struct {
		object string
		want   []string
	}{
		{schema + ".Order Items", []string{
			`CREATE TABLE ` + schema + `."Order Items" (`,
			`bigint GENERATED ALWAYS AS IDENTITY (START WITH 100 INCREMENT BY 10) NOT NULL`,
			`text COLLATE pg_catalog."C"`,
			`) WITH (fillfactor=70);`,
			`CREATE SEQUENCE ` + schema + `."Order Items_line_no_seq" AS integer START WITH 7;`,
			`line_no    integer DEFAULT nextval('` + schema + `."Order Items_line_no_seq"'::regclass) NOT NULL`,
			`ALTER SEQUENCE ` + schema + `."Order Items_line_no_seq" OWNED BY ` + schema + `."Order Items".line_no;`,
			`CREATE SEQUENCE ` + schema + `.batch_counter AS integer MINVALUE 50;`,
			`ALTER SEQUENCE ` + schema + `.batch_counter OWNED BY ` + schema + `."Order Items".batch;`,
			`plain_no   serial NOT NULL`,
			`integer DEFAULT 1 NOT NULL`,
			`numeric(10,2),`,
			`GENERATED ALWAYS AS (((qty)::numeric * price)) STORED`,
			`PRIMARY KEY (id)`,
			`UNIQUE (sku)`,
			`FOREIGN KEY (account_id) REFERENCES ` + schema + `.accounts(id)`,
			`CHECK (qty > 0)`,
			`CREATE INDEX order_items_account_idx ON ` + schema + `."Order Items" USING btree (account_id) WHERE (qty > 1);`,
		}},
		{schema + ".big_orders", []string{`CREATE VIEW ` + schema + `.big_orders WITH (`, `security_invoker=true`, `check_option=cascaded`, `) AS`, `WHERE qty > 10;`}},
		{schema + ".events", []string{`) PARTITION BY RANGE (at);`}},
	}
	for _, tt := range tests {
		t.Run(tt.object, func(t *testing.T) {
			ddl, err := p.ObjectDDL(ctx, tt.object)
			if err != nil {
				t.Fatalf("ObjectDDL: %v", err)
			}
			for _, want := range tt.want {
				if !strings.Contains(ddl, want) {
					t.Errorf("missing %q in:\n%s", want, ddl)
				}
			}
		})
	}

	t.Run("constraint-backed indexes are not repeated", func(t *testing.T) {
		ddl, _ := p.ObjectDDL(ctx, schema+".Order Items")
		if n := strings.Count(ddl, "CREATE INDEX"); n != 1 {
			t.Fatalf("want one CREATE INDEX, got %d:\n%s", n, ddl)
		}
	})

	// The point of the feature: what it prints recreates the objects, and they
	// behave like the originals — not merely parse.
	t.Run("output replays into an empty schema and behaves the same", func(t *testing.T) {
		replica := schema + "_replica"
		exec(`CREATE SCHEMA ` + replica)
		t.Cleanup(func() { _, _ = p.pool.Exec(context.Background(), `DROP SCHEMA `+replica+` CASCADE`) })
		exec(`CREATE TABLE ` + replica + `.accounts (id bigint PRIMARY KEY)`)
		for _, object := range []string{".Order Items", ".big_orders"} {
			ddl, err := p.ObjectDDL(ctx, schema+object)
			if err != nil {
				t.Fatalf("ObjectDDL: %v", err)
			}
			exec(strings.ReplaceAll(ddl, schema+".", replica+"."))
		}

		var id, lineNo, batch, plainNo int64
		var collation, tableOptions, viewOptions string
		exec(`INSERT INTO ` + replica + `.accounts VALUES (1)`)
		if err := p.pool.QueryRow(ctx, `INSERT INTO `+replica+`."Order Items" (account_id) VALUES (1) RETURNING id, line_no, batch, plain_no`).Scan(&id, &lineNo, &batch, &plainNo); err != nil {
			t.Fatalf("insert into replica: %v", err)
		}
		if err := p.pool.QueryRow(ctx, `SELECT co.collname,
				array_to_string((SELECT reloptions FROM pg_class WHERE oid = $1::regclass), ','),
				array_to_string((SELECT reloptions FROM pg_class WHERE oid = $2::regclass), ',')
			FROM pg_attribute a JOIN pg_collation co ON co.oid = a.attcollation
			WHERE a.attrelid = $1::regclass AND a.attname = 'code'`,
			replica+`."Order Items"`, replica+`.big_orders`).Scan(&collation, &tableOptions, &viewOptions); err != nil {
			t.Fatalf("read replica catalog: %v", err)
		}
		if id != 100 || lineNo != 7 || batch != 50 || plainNo != 1 {
			t.Errorf("first row got id=%d line_no=%d batch=%d plain_no=%d, want 100, 7, 50, 1 as in the original sequences",
				id, lineNo, batch, plainNo)
		}
		if collation != "C" {
			t.Errorf("code collation = %q, want C", collation)
		}
		if tableOptions != "fillfactor=70" {
			t.Errorf("table reloptions = %q", tableOptions)
		}
		if !strings.Contains(viewOptions, "security_invoker=true") || !strings.Contains(viewOptions, "check_option=cascaded") {
			t.Errorf("view reloptions = %q", viewOptions)
		}
	})

	t.Run("unknown object", func(t *testing.T) {
		if _, err := p.ObjectDDL(ctx, schema+".nope"); !errors.Is(err, connector.ErrRelationNotFound) {
			t.Fatalf("err = %v, want ErrRelationNotFound", err)
		}
	})
}
