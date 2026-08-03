package postgres

import (
	"context"
	"errors"
	"os"
	"testing"
	"time"

	"github.com/zxchlorka/kizuna/internal/config"
	"github.com/zxchlorka/kizuna/internal/connector"
)

// Gated integration test for the SQL console's Cancel/Stop feature. It needs a
// real Postgres to prove three things a mock cannot: (1) canceling the request
// context actually interrupts a running query instead of letting it finish,
// (2) the resulting error normalizes to connector.ErrCanceled, and (3) the
// pgxpool stays usable afterward -- pgx may hard-close the underlying
// connection when a soft CancelRequest doesn't unblock in time, and the pool
// must transparently open a replacement rather than staying poisoned.
//
// Skipped unless POSTGRES_CANCEL_TEST=1. When set, it ONLY ever targets the
// local docker-compose.test.yml Postgres (127.0.0.1:55432, dev/dev/devdb) --
// the host/port/credentials below are hardcoded to that fixture, never read
// from the environment, so this can never reach a real/production database
// (see CLAUDE.md: production connections are never to be used for testing).
func newLocalCancelTestConnector(t *testing.T) *PostgresConnector {
	t.Helper()
	if os.Getenv("POSTGRES_CANCEL_TEST") != "1" {
		t.Skip("set POSTGRES_CANCEL_TEST=1 with docker-compose.test.yml's postgres service running to exercise this")
	}

	cfg := config.ConnectionConfig{
		ID:       "cancel-test",
		Type:     "postgres",
		Host:     "127.0.0.1",
		Port:     55432,
		Database: "devdb",
		Username: "dev",
		Password: "dev",
	}

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	conn, err := New(ctx, cfg, "")
	if err != nil {
		t.Fatalf("connect to local test postgres (is docker-compose.test.yml's postgres up?): %v", err)
	}
	t.Cleanup(func() { conn.Close() })
	return conn
}

func TestExecuteCancelStopsQueryAndNormalizesError(t *testing.T) {
	t.Parallel()
	p := newLocalCancelTestConnector(t)

	ctx, cancel := context.WithCancel(context.Background())
	go func() {
		time.Sleep(300 * time.Millisecond)
		cancel()
	}()

	started := time.Now()
	_, err := p.Execute(ctx, "SELECT pg_sleep(30)")
	elapsed := time.Since(started)

	if err == nil {
		t.Fatal("expected an error from a canceled query")
	}
	if !errors.Is(err, connector.ErrCanceled) {
		t.Fatalf("expected ErrCanceled, got %v", err)
	}
	// Generous upper bound: proves the query was actually interrupted rather
	// than running to completion (pg_sleep(30) would take 30s+).
	if elapsed > 10*time.Second {
		t.Fatalf("cancel took too long to take effect: %v", elapsed)
	}
}

func TestExecuteCancelDoesNotPoisonPool(t *testing.T) {
	t.Parallel()
	p := newLocalCancelTestConnector(t)

	ctx, cancel := context.WithCancel(context.Background())
	go func() {
		time.Sleep(300 * time.Millisecond)
		cancel()
	}()
	if _, err := p.Execute(ctx, "SELECT pg_sleep(30)"); err == nil {
		t.Fatal("expected the canceled query to error")
	}

	// The pool must still serve requests: whether pgx recycled the same
	// connection or force-closed it and opened a new one, the next query on
	// this connector must succeed normally.
	result, err := p.Execute(context.Background(), "SELECT 1")
	if err != nil {
		t.Fatalf("pool did not recover after cancel: %v", err)
	}
	if result.RowsReturned != 1 {
		t.Fatalf("unexpected result after recovery: %+v", result)
	}
}

// ExecuteBatch runs each statement autocommitted on a single acquired session
// (no BEGIN/COMMIT wraps the batch -- see the comment in execute.go). A cancel
// mid-batch must not undo statements that already committed: only the
// in-flight statement is stopped and flagged Canceled, and the connector must
// still be usable afterward.
func TestExecuteBatchCancelFlagsInFlightStatementAndPreservesPriorCommits(t *testing.T) {
	t.Parallel()
	p := newLocalCancelTestConnector(t)

	setup := context.Background()
	if _, err := p.Execute(setup, "DROP TABLE IF EXISTS cancel_batch_probe"); err != nil {
		t.Fatalf("drop probe table: %v", err)
	}
	if _, err := p.Execute(setup, "CREATE TABLE cancel_batch_probe (id integer)"); err != nil {
		t.Fatalf("create probe table: %v", err)
	}
	t.Cleanup(func() {
		_, _ = p.Execute(context.Background(), "DROP TABLE IF EXISTS cancel_batch_probe")
	})

	ctx, cancel := context.WithCancel(context.Background())
	go func() {
		time.Sleep(300 * time.Millisecond)
		cancel()
	}()

	results, err := p.ExecuteBatch(ctx, []string{
		"INSERT INTO cancel_batch_probe (id) VALUES (1)",
		"SELECT pg_sleep(30)",
		"INSERT INTO cancel_batch_probe (id) VALUES (2)",
	})
	if err != nil {
		t.Fatalf("ExecuteBatch returned a top-level error: %v", err)
	}
	if len(results) != 3 {
		t.Fatalf("expected 3 results, got %d: %+v", len(results), results)
	}
	if results[0].Error != "" || results[0].Canceled {
		t.Fatalf("first statement should have committed cleanly, got %+v", results[0])
	}
	if !results[1].Canceled {
		t.Fatalf("second (in-flight) statement should be flagged Canceled, got %+v", results[1])
	}
	if !results[2].Skipped {
		t.Fatalf("third statement should be skipped after the cancel, got %+v", results[2])
	}

	// Autocommit, no transaction: the first INSERT's commit must survive the
	// cancel of the statement after it.
	var count int
	row := p.pool.QueryRow(context.Background(), "SELECT count(*) FROM cancel_batch_probe")
	if err := row.Scan(&count); err != nil {
		t.Fatalf("verify committed rows: %v", err)
	}
	if count != 1 {
		t.Fatalf("expected exactly the pre-cancel INSERT to have committed, got %d rows", count)
	}
}
