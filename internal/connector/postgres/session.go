package postgres

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/zxchlorka/kizuna/internal/connector"
)

// rollbackTimeout bounds the ROLLBACK an ended session sends. It is not a
// query timeout: it only stops a dead server from holding up a tab close.
const rollbackTimeout = 5 * time.Second

// sessionIdleTimeout is how long a console transaction may sit with nothing
// running before it is rolled back. A tab whose browser went away would
// otherwise hold its locks and a pool connection until Kizuna restarts. It
// never touches a running statement: the clock starts when a run finishes.
const sessionIdleTimeout = 30 * time.Minute

var errSessionEnded = errors.New("this console session has ended")

var errSessionExpired = errors.New("the transaction sat idle for 30 minutes and was rolled back; nothing was run, start it again")

// consoleSession is the connection one SQL console tab holds while it has a
// transaction open. turn makes runs of one tab take turns (two statements on
// one connection at once fail with "conn busy"); it is a channel rather than a
// mutex so a caller can give up waiting when its request goes away.
type consoleSession struct {
	turn  chan struct{}
	conn  *pgxpool.Conn
	ended bool
	// lost remembers that the last run dropped an open transaction, for a
	// console that missed the response (a Stop aborts its request).
	lost bool
	// expired is set when the idle timer rolled the transaction back. The next
	// run is refused once, so statements meant for that transaction are not
	// silently autocommitted.
	expired bool
	idle    *time.Timer
	// idleGen tells a timer that fired while a run held the lock that the
	// run has re-armed it since.
	idleGen int
}

func (s *consoleSession) lock(ctx context.Context) error {
	select {
	case s.turn <- struct{}{}:
		return nil
	case <-ctx.Done():
		return normalizePostgresError(ctx.Err())
	}
}

func (s *consoleSession) unlock() { <-s.turn }

func (p *PostgresConnector) session(id string) *consoleSession {
	p.sessionsMu.Lock()
	defer p.sessionsMu.Unlock()
	s, ok := p.sessions[id]
	if !ok {
		s = &consoleSession{turn: make(chan struct{}, 1)}
		p.sessions[id] = s
	}
	return s
}

func txStateOf(conn *pgxpool.Conn) connector.TxState {
	switch conn.Conn().PgConn().TxStatus() {
	case 'T':
		return connector.TxOpen
	case 'E':
		return connector.TxFailed
	default:
		return connector.TxIdle
	}
}

// inSession runs fn on the tab's pinned connection, or on a fresh one from the
// pool. Afterwards the connection stays pinned only if a transaction is open
// on it; otherwise it goes straight back to the pool.
func (p *PostgresConnector) inSession(ctx context.Context, id string, fn func(*pgxpool.Conn) error) (connector.TxState, error) {
	s := p.session(id)
	if err := s.lock(ctx); err != nil {
		return connector.TxIdle, err
	}
	defer s.unlock()
	if s.ended {
		return connector.TxIdle, fmt.Errorf("%w: %s", connector.ErrBadRequest, errSessionEnded)
	}
	if s.expired {
		s.expired = false
		return connector.TxExpired, fmt.Errorf("%w: %s", connector.ErrBadRequest, errSessionExpired)
	}
	s.stopIdle()

	if s.conn == nil {
		conn, err := p.pool.Acquire(ctx)
		if err != nil {
			return connector.TxIdle, normalizePostgresError(err)
		}
		s.conn = conn
	}
	wasInTx := txStateOf(s.conn) != connector.TxIdle
	s.lost = false

	runErr := fn(s.conn)

	if s.conn.Conn().IsClosed() {
		// A cancel closes the connection; the server rolled back whatever the
		// transaction held. Release lets the pool discard it.
		s.conn.Release()
		s.conn = nil
		if wasInTx {
			s.lost = true
			return connector.TxLost, runErr
		}
		return connector.TxIdle, runErr
	}

	state := txStateOf(s.conn)
	if state == connector.TxIdle {
		s.conn.Release()
		s.conn = nil
	} else {
		p.armIdle(s)
	}
	return state, runErr
}

// armIdle starts the idle clock of a session left holding a transaction.
// Callers hold the session lock.
func (p *PostgresConnector) armIdle(s *consoleSession) {
	s.idleGen++
	gen := s.idleGen
	s.idle = time.AfterFunc(p.sessionIdle, func() { p.expireSession(s, gen) })
}

func (s *consoleSession) stopIdle() {
	if s.idle != nil {
		s.idle.Stop()
		s.idle = nil
	}
	s.idleGen++
}

func (p *PostgresConnector) expireSession(s *consoleSession, gen int) {
	_ = s.lock(context.Background())
	defer s.unlock()
	if s.ended || s.idleGen != gen || s.conn == nil {
		return
	}
	p.rollbackAndRelease(s)
	s.idle = nil
	s.expired = true
}

func (p *PostgresConnector) ExecuteInSession(ctx context.Context, sessionID, command string) (*connector.ExecResult, connector.TxState, error) {
	var result *connector.ExecResult
	state, err := p.inSession(ctx, sessionID, func(conn *pgxpool.Conn) error {
		var execErr error
		result, execErr = p.executeWithExecutor(ctx, conn, command)
		return execErr
	})
	return result, state, err
}

func (p *PostgresConnector) ExecuteBatchInSession(ctx context.Context, sessionID string, commands []string) ([]connector.ExecResult, connector.TxState, error) {
	var results []connector.ExecResult
	state, err := p.inSession(ctx, sessionID, func(conn *pgxpool.Conn) error {
		var batchErr error
		results, batchErr = p.executeBatchOn(ctx, conn, commands)
		return batchErr
	})
	return results, state, err
}

// SessionState waits for a run in progress to finish before answering: right
// after a Stop the canceled statement is still unwinding, and only once it has
// is it known whether the transaction survived.
func (p *PostgresConnector) SessionState(ctx context.Context, sessionID string) (connector.TxState, error) {
	p.sessionsMu.Lock()
	s, ok := p.sessions[sessionID]
	p.sessionsMu.Unlock()
	if !ok {
		return connector.TxIdle, nil
	}
	if err := s.lock(ctx); err != nil {
		return "", err
	}
	defer s.unlock()
	if s.lost {
		return connector.TxLost, nil
	}
	if s.expired {
		return connector.TxExpired, nil
	}
	if s.conn == nil {
		return connector.TxIdle, nil
	}
	return txStateOf(s.conn), nil
}

func (p *PostgresConnector) EndSession(ctx context.Context, sessionID string) error {
	p.sessionsMu.Lock()
	s, ok := p.sessions[sessionID]
	delete(p.sessions, sessionID)
	p.sessionsMu.Unlock()
	if !ok {
		return nil
	}
	p.endSession(ctx, s)
	return nil
}

// endSession waits for a run in progress: the connection is not free to roll
// back until it finishes.
func (p *PostgresConnector) endSession(ctx context.Context, s *consoleSession) {
	_ = s.lock(context.WithoutCancel(ctx))
	defer s.unlock()
	s.ended = true
	s.stopIdle()
	if s.conn == nil {
		return
	}
	p.rollbackAndRelease(s)
}

// rollbackAndRelease hands a pinned connection back to the pool, rolling back
// whatever transaction it still holds. Callers hold the session lock.
func (p *PostgresConnector) rollbackAndRelease(s *consoleSession) {
	if txStateOf(s.conn) != connector.TxIdle {
		rollbackCtx, cancel := context.WithTimeout(context.Background(), rollbackTimeout)
		defer cancel()
		if _, err := s.conn.Exec(rollbackCtx, "ROLLBACK"); err != nil {
			// Releasing a connection still inside a transaction makes the pool
			// destroy it, and the server rolls back on disconnect anyway.
			slog.Warn("console session rollback failed", "error", err)
		}
	}
	s.conn.Release()
	s.conn = nil
}

// endAllSessions runs before the pool closes: pgxpool.Close waits for every
// acquired connection, and a pinned one would never come back on its own.
func (p *PostgresConnector) endAllSessions() {
	p.sessionsMu.Lock()
	sessions := p.sessions
	p.sessions = make(map[string]*consoleSession)
	p.sessionsMu.Unlock()
	for _, s := range sessions {
		p.endSession(context.Background(), s)
	}
}
