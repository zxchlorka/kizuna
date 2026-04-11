package connector

import (
	"context"
	"errors"
	"fmt"
	"sync"

	"github.com/qsnake66/infraview/internal/config"
)

// ConnectorFactory creates a Connector from a connection config.
type ConnectorFactory func(ctx context.Context, cfg config.ConnectionConfig, encKey string) (Connector, error)

// ConnectionManager manages lazy-initialized connectors.
type ConnectionManager struct {
	mu         sync.RWMutex
	connectors map[string]Connector
	config     *config.AppConfig
	factories  map[string]ConnectorFactory
}

func NewConnectionManager(cfg *config.AppConfig) *ConnectionManager {
	return &ConnectionManager{
		connectors: make(map[string]Connector),
		config:     cfg,
		factories:  make(map[string]ConnectorFactory),
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
	if c, ok := m.connectors[id]; ok {
		m.mu.RUnlock()
		if err := c.Ping(ctx); err == nil {
			return c, nil
		}
		m.Remove(id)
		return m.createConnector(ctx, id, true)
	}
	m.mu.RUnlock()

	return m.createConnector(ctx, id, true)
}

func (m *ConnectionManager) createConnector(ctx context.Context, id string, retry bool) (Connector, error) {
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

	m.mu.Lock()
	defer m.mu.Unlock()

	// Double-check after acquiring write lock
	if c, ok := m.connectors[id]; ok {
		if err := c.Ping(ctx); err == nil {
			return c, nil
		}
		c.Close()
		delete(m.connectors, id)
	}

	c, err := factory(ctx, connCfg, m.config.EncryptionKey)
	if err != nil && retry && isConnectionError(err) {
		c, err = factory(ctx, connCfg, m.config.EncryptionKey)
	}
	if err != nil {
		return nil, fmt.Errorf("failed to create connector for %q: %w", id, err)
	}

	m.connectors[id] = c
	return c, nil
}

func isConnectionError(err error) bool {
	return errors.Is(err, ErrUnavailable) || errors.Is(err, ErrTimeout)
}

// Remove closes and removes a connector from the pool.
func (m *ConnectionManager) Remove(id string) {
	m.mu.Lock()
	defer m.mu.Unlock()

	if c, ok := m.connectors[id]; ok {
		c.Close()
		delete(m.connectors, id)
	}
}

// CloseAll closes all active connectors.
func (m *ConnectionManager) CloseAll() {
	m.mu.Lock()
	defer m.mu.Unlock()

	for id, c := range m.connectors {
		c.Close()
		delete(m.connectors, id)
	}
}
