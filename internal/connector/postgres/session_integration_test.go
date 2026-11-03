package postgres

import (
	"context"
	"fmt"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/zxchlorka/kizuna/internal/config"
	"github.com/zxchlorka/kizuna/internal/connector"
)

// Gated integration test for SQL console sessions: a transaction opened in one
// run has to survive into the next ones until COMMIT or ROLLBACK, which only a
// real server can show. Skipped unless POSTGRES_SESSION_TEST=1; like the cancel
// test it ONLY targets docker-compose.test.yml's Postgres (127.0.0.1:55432,
// dev/dev/devdb), hardcoded so it can never reach a real database.
func newLocalSessionTestConnector(t *testing.T) *PostgresConnector {
	t.Helper()
	if os.Getenv("POSTGRES_SESSION_TEST") != "1" {
		t.Skip("set POSTGRES_SESSION_TEST=1 with docker-compose.test.yml's postgres service running to exercise this")
	}
	cfg := config.ConnectionConfig{ID: "session-test", Type: "postgres", Host: "127.0.0.1", Port: 55432, Database: "devdb", Username: "dev", Password: "dev"}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	conn, err := New(ctx, cfg, "")
	if err != nil {
		t.Fatalf("connect to local test postgres (is docker-compose.test.yml's postgres up?): %v", err)
	}
	t.Cleanup(func() { conn.Close() })
	return conn
}

// tableName gives each test its own tables, so parallel tests never meet.
func tableName(t *testing.T, suffix string) string {
	return "session_" + strings.ToLower(strings.NewReplacer("/", "_", " ", "_").Replace(t.Name())) + "_" + suffix
}

func mustRun(t *testing.T, p *PostgresConnector, session string, statements ...string) connector.TxState {
	t.Helper()
	results, state, err := p.ExecuteBatchInSession(context.Background(), session, statements)
	if err != nil {
		t.Fatalf("run %v: %v", statements, err)
	}
	for _, r := range results {
		if r.Error != "" {
			t.Fatalf("statement %q failed: %s", r.Statement, r.Error)
		}
	}
	return state
}

func tableExists(t *testing.T, p *PostgresConnector, name string) bool {
	t.Helper()
	var exists bool
	if err := p.pool.QueryRow(context.Background(), "SELECT to_regclass($1) IS NOT NULL", "public."+name).Scan(&exists); err != nil {
		t.Fatal(err)
	}
	return exists
}

func countRows(t *testing.T, p *PostgresConnector, name string) int {
	t.Helper()
	var n int
	if err := p.pool.QueryRow(context.Background(), fmt.Sprintf("SELECT count(*) FROM public.%s", name)).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

func setupTables(t *testing.T, p *PostgresConnector, names ...string) {
	t.Helper()
	for _, name := range names {
		if _, err := p.pool.Exec(context.Background(), fmt.Sprintf("DROP TABLE IF EXISTS public.%[1]s; CREATE TABLE public.%[1]s (id int)", name)); err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _, _ = p.pool.Exec(context.Background(), "DROP TABLE IF EXISTS public."+name) })
	}
}

// The console workflow that used to commit nothing: BEGIN, then a DROP, a
// SELECT and an INSERT as separate runs, and COMMIT last.
func TestSessionKeepsTransactionAcrossRuns(t *testing.T) {
	t.Parallel()
	p := newLocalSessionTestConnector(t)
	dropped, kept := tableName(t, "dropped"), tableName(t, "kept")
	setupTables(t, p, dropped, kept)

	steps := []struct {
		statement string
		want      connector.TxState
	}{
		{"BEGIN", connector.TxOpen},
		{"DROP TABLE public." + dropped, connector.TxOpen},
		{"SELECT count(*) FROM public." + kept, connector.TxOpen},
		{"INSERT INTO public." + kept + " VALUES (1), (2)", connector.TxOpen},
	}
	for _, step := range steps {
		if got := mustRun(t, p, "tab-1", step.statement); got != step.want {
			t.Fatalf("%q: state %q, want %q", step.statement, got, step.want)
		}
	}

	// Nothing is visible outside the session before COMMIT.
	if !tableExists(t, p, dropped) || countRows(t, p, kept) != 0 {
		t.Fatal("uncommitted changes leaked out of the session")
	}

	if got := mustRun(t, p, "tab-1", "COMMIT"); got != connector.TxIdle {
		t.Fatalf("COMMIT left state %q", got)
	}
	if tableExists(t, p, dropped) || countRows(t, p, kept) != 2 {
		t.Fatal("COMMIT in a later run did not apply the transaction")
	}
}

func TestSessionRollbackInLaterRunUndoes(t *testing.T) {
	t.Parallel()
	p := newLocalSessionTestConnector(t)
	name := tableName(t, "t")
	setupTables(t, p, name)

	mustRun(t, p, "tab-1", "BEGIN", "DROP TABLE public."+name)
	if got := mustRun(t, p, "tab-1", "ROLLBACK"); got != connector.TxIdle {
		t.Fatalf("ROLLBACK left state %q", got)
	}
	if !tableExists(t, p, name) {
		t.Fatal("ROLLBACK did not undo the DROP")
	}
}

func TestSessionFailedStatementLeavesTransactionFailed(t *testing.T) {
	t.Parallel()
	p := newLocalSessionTestConnector(t)

	mustRun(t, p, "tab-1", "BEGIN")
	_, state, err := p.ExecuteInSession(context.Background(), "tab-1", "SELECT * FROM public.no_such_table_anywhere")
	if err == nil || state != connector.TxFailed {
		t.Fatalf("err=%v state=%q, want an error and %q", err, state, connector.TxFailed)
	}
	if got := mustRun(t, p, "tab-1", "ROLLBACK"); got != connector.TxIdle {
		t.Fatalf("ROLLBACK after failure left state %q", got)
	}
}

func TestSessionsOfDifferentTabsAreIsolated(t *testing.T) {
	t.Parallel()
	p := newLocalSessionTestConnector(t)
	name := tableName(t, "t")
	setupTables(t, p, name)

	mustRun(t, p, "tab-1", "BEGIN", "INSERT INTO public."+name+" VALUES (1)")
	results, state, err := p.ExecuteBatchInSession(context.Background(), "tab-2", []string{"SELECT count(*) FROM public." + name})
	if err != nil || state != connector.TxIdle || fmt.Sprint(results[0].Rows[0][0]) != "0" {
		t.Fatalf("tab-2 saw tab-1's open transaction: err=%v state=%q rows=%v", err, state, results)
	}
	mustRun(t, p, "tab-1", "ROLLBACK")
}

func TestEndSessionRollsBackAndFreesConnection(t *testing.T) {
	t.Parallel()
	p := newLocalSessionTestConnector(t)
	name := tableName(t, "t")
	setupTables(t, p, name)

	mustRun(t, p, "tab-1", "BEGIN", "DROP TABLE public."+name)
	if got, _ := p.SessionState(context.Background(), "tab-1"); got != connector.TxOpen {
		t.Fatalf("SessionState = %q, want open", got)
	}
	if err := p.EndSession(context.Background(), "tab-1"); err != nil {
		t.Fatal(err)
	}
	if !tableExists(t, p, name) {
		t.Fatal("closing the tab did not roll back its open transaction")
	}
	if got, _ := p.SessionState(context.Background(), "tab-1"); got != connector.TxIdle {
		t.Fatalf("SessionState after end = %q", got)
	}
}

func TestSessionCancelInsideTransactionReportsLost(t *testing.T) {
	t.Parallel()
	p := newLocalSessionTestConnector(t)
	name := tableName(t, "t")
	setupTables(t, p, name)

	mustRun(t, p, "tab-1", "BEGIN", "DROP TABLE public."+name)

	ctx, cancel := context.WithCancel(context.Background())
	go func() {
		time.Sleep(300 * time.Millisecond)
		cancel()
	}()
	_, state, err := p.ExecuteInSession(ctx, "tab-1", "SELECT pg_sleep(30)")
	if err == nil {
		t.Fatal("expected the canceled statement to fail")
	}
	// What the console asks after a Stop, when it never saw the response.
	if asked, _ := p.SessionState(context.Background(), "tab-1"); asked != state {
		t.Fatalf("SessionState after the cancel = %q, the run said %q", asked, state)
	}
	// pgx may keep the connection (soft cancel: the transaction is failed) or
	// close it (the server rolls it back). Either way it must not read as open.
	if state != connector.TxLost && state != connector.TxFailed {
		t.Fatalf("state after cancel = %q, want lost or failed", state)
	}
	if state == connector.TxFailed {
		mustRun(t, p, "tab-1", "ROLLBACK")
	}
	if !tableExists(t, p, name) {
		t.Fatal("a canceled transaction applied its DROP")
	}
}

// An abandoned tab must not hold its transaction forever: after the idle
// timeout it is rolled back, the next run is refused once with TxExpired so its
// statements are not silently autocommitted, and the run after that works.
func TestSessionIdleTimeoutRollsBackAndRefusesNextRun(t *testing.T) {
	t.Parallel()
	p := newLocalSessionTestConnector(t)
	p.sessionIdle = 300 * time.Millisecond
	table := tableName(t, "t")
	setupTables(t, p, table)

	if state := mustRun(t, p, "tab", "BEGIN", fmt.Sprintf("INSERT INTO public.%s VALUES (1)", table)); state != connector.TxOpen {
		t.Fatalf("state after BEGIN = %s, want open", state)
	}
	// A run inside the window resets the clock.
	time.Sleep(200 * time.Millisecond)
	mustRun(t, p, "tab", "SELECT 1")
	time.Sleep(200 * time.Millisecond)
	if state, _ := p.SessionState(context.Background(), "tab"); state != connector.TxOpen {
		t.Fatalf("session expired although a run reset its clock: %s", state)
	}

	time.Sleep(400 * time.Millisecond)
	if state, _ := p.SessionState(context.Background(), "tab"); state != connector.TxExpired {
		t.Fatalf("state after idle timeout = %s, want expired", state)
	}
	if n := countRows(t, p, table); n != 0 {
		t.Fatalf("expired transaction left %d rows, want 0", n)
	}

	_, state, err := p.ExecuteInSession(context.Background(), "tab", fmt.Sprintf("INSERT INTO public.%s VALUES (2)", table))
	if err == nil || state != connector.TxExpired {
		t.Fatalf("first run after expiry: state %s, err %v; want refused with expired", state, err)
	}
	if n := countRows(t, p, table); n != 0 {
		t.Fatalf("refused run still wrote %d rows", n)
	}
	if state := mustRun(t, p, "tab", "SELECT 1"); state != connector.TxIdle {
		t.Fatalf("run after the refusal = %s, want idle", state)
	}
}
