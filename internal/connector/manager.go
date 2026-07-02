package connector

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"sync"
	"time"

	"github.com/qsnake66/kizuna/internal/config"
)

// ConnectorFactory creates a Connector from a connection config.
type ConnectorFactory func(ctx context.Context, cfg config.ConnectionConfig, encKey string) (Connector, error)

// ConnectionManager manages lazy-initialized connectors.
type ConnectionManager struct {
	mu         sync.RWMutex
	connectors map[string]managedConnector
	config     *config.AppConfig
	factories  map[string]ConnectorFactory
	inFlight   map[string]*connectorCall
	failures   map[string]connectionFailure
}

type managedConnector struct {
	connector       Connector
	lastValidatedAt time.Time
}

type connectorCall struct {
	done      chan struct{}
	connector Connector
	err       error
}

type connectionFailure struct {
	err       error
	expiresAt time.Time
}

const connectionFailureCooldown = 2 * time.Second

func NewConnectionManager(cfg *config.AppConfig) *ConnectionManager {
	return &ConnectionManager{
		connectors: make(map[string]managedConnector),
		config:     cfg,
		factories:  make(map[string]ConnectorFactory),
		inFlight:   make(map[string]*connectorCall),
		failures:   make(map[string]connectionFailure),
	}
}

// RegisterFactory registers a connector factory for a given connection type.
func (m *ConnectionManager) RegisterFactory(connType string, factory ConnectorFactory) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.factories[connType] = factory
}

func (m *ConnectionManager) Factory(connType string) (ConnectorFactory, bool) {
	m.mu.RLock()
	defer m.mu.RUnlock()

	factory, ok := m.factories[connType]
	return factory, ok
}

// Get returns a connector for the given connection ID, creating it lazily if needed.
func (m *ConnectionManager) Get(ctx context.Context, id string) (Connector, error) {
	m.mu.RLock()
	if managed, ok := m.connectors[id]; ok {
		m.mu.RUnlock()
		return managed.connector, nil
	}
	m.mu.RUnlock()

	return m.createConnector(ctx, id, false)
}

// Check validates a connection explicitly. Normal data/tree requests use Get()
// and do not re-ping a recently created connector on every endpoint call.
func (m *ConnectionManager) Check(ctx context.Context, id string) error {
	conn, err := m.createConnector(ctx, id, true)
	if err != nil {
		return err
	}

	start := time.Now()
	if err := conn.Ping(ctx); err != nil {
		logSlowConnectorPhase("health_ping", id, time.Since(start))
		m.Remove(id)
		m.markFailure(id, err)
		return err
	}
	logSlowConnectorPhase("health_ping", id, time.Since(start))
	m.markValidated(id)
	return nil
}

func (m *ConnectionManager) createConnector(ctx context.Context, id string, bypassCooldown bool) (Connector, error) {
	if !bypassCooldown {
		if err := m.cooldownError(id); err != nil {
			return nil, err
		}
	}

	start := time.Now()
	call, owner, err := m.beginConnectorCall(id)
	if err != nil {
		return nil, err
	}
	if !owner {
		return waitConnectorCall(ctx, call)
	}
	defer func() {
		logSlowConnectorPhase("create", id, time.Since(start))
	}()

	conn, err := m.openConnector(ctx, id)
	m.finishConnectorCall(id, call, conn, err)
	if err != nil {
		return nil, err
	}
	return conn, nil
}

func (m *ConnectionManager) openConnector(ctx context.Context, id string) (Connector, error) {
	connCfg, ok := m.config.GetConnection(id)
	if !ok {
		return nil, fmt.Errorf("connection %q not found", id)
	}

	m.mu.RLock()
	factory, ok := m.factories[connCfg.Type]
	m.mu.RUnlock()
	if !ok {
		return nil, fmt.Errorf("unsupported connection type: %s", connCfg.Type)
	}

	c, err := factory(ctx, connCfg, m.config.EncryptionKey)
	// Retry once on a transient connection error so a single dial/ping blip on
	// first open does not surface as an error the user has to manually retry.
	if err != nil && isConnectionError(err) {
		c, err = factory(ctx, connCfg, m.config.EncryptionKey)
	}
	if err != nil {
		return nil, fmt.Errorf("failed to create connector for %q: %w", id, err)
	}
	return c, nil
}

func (m *ConnectionManager) beginConnectorCall(id string) (*connectorCall, bool, error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	if managed, ok := m.connectors[id]; ok {
		return &connectorCall{
			done:      closedDone(),
			connector: managed.connector,
		}, false, nil
	}

	if call, ok := m.inFlight[id]; ok {
		return call, false, nil
	}

	call := &connectorCall{done: make(chan struct{})}
	m.inFlight[id] = call
	return call, true, nil
}

func (m *ConnectionManager) finishConnectorCall(id string, call *connectorCall, conn Connector, err error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	call.connector = conn
	call.err = err
	delete(m.inFlight, id)

	if err == nil {
		m.connectors[id] = managedConnector{
			connector:       conn,
			lastValidatedAt: time.Now(),
		}
		delete(m.failures, id)
	} else if isConnectionError(err) {
		m.failures[id] = connectionFailure{
			err:       err,
			expiresAt: time.Now().Add(connectionFailureCooldown),
		}
	}

	close(call.done)
}

func isConnectionError(err error) bool {
	return errors.Is(err, ErrUnavailable) || errors.Is(err, ErrTimeout)
}

func waitConnectorCall(ctx context.Context, call *connectorCall) (Connector, error) {
	select {
	case <-call.done:
		return call.connector, call.err
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

func closedDone() chan struct{} {
	done := make(chan struct{})
	close(done)
	return done
}

func (m *ConnectionManager) cooldownError(id string) error {
	m.mu.Lock()
	defer m.mu.Unlock()

	failure, ok := m.failures[id]
	if !ok {
		return nil
	}
	if time.Now().After(failure.expiresAt) {
		delete(m.failures, id)
		return nil
	}
	return fmt.Errorf("connection %q is temporarily unavailable: %w", id, failure.err)
}

func (m *ConnectionManager) markFailure(id string, err error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	m.failures[id] = connectionFailure{
		err:       err,
		expiresAt: time.Now().Add(connectionFailureCooldown),
	}
}

// Remove closes and removes a connector from the pool.
func (m *ConnectionManager) Remove(id string) {
	m.mu.Lock()
	defer m.mu.Unlock()

	if c, ok := m.connectors[id]; ok {
		c.connector.Close()
		delete(m.connectors, id)
	}
	delete(m.failures, id)
}

// CloseAll closes all active connectors.
func (m *ConnectionManager) CloseAll() {
	m.mu.Lock()
	defer m.mu.Unlock()

	for id, c := range m.connectors {
		c.connector.Close()
		delete(m.connectors, id)
	}
	m.failures = make(map[string]connectionFailure)
}

func (m *ConnectionManager) markValidated(id string) {
	m.mu.Lock()
	defer m.mu.Unlock()

	managed, ok := m.connectors[id]
	if !ok {
		return
	}
	managed.lastValidatedAt = time.Now()
	m.connectors[id] = managed
}

func logSlowConnectorPhase(phase, id string, duration time.Duration) {
	if duration < 250*time.Millisecond {
		return
	}

	slog.Info("slow connector manager phase",
		"phase", phase,
		"connection_id", id,
		"duration_ms", duration.Milliseconds(),
	)
}
