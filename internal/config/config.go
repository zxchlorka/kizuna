package config

import (
	"encoding/json"
	"os"
	"slices"
	"sync"
)

type ConnectionConfig struct {
	ID             string       `json:"id"`
	Name           string       `json:"name"`
	Type           string       `json:"type"` // "postgres", "redis", "kafka"
	Host           string       `json:"host"`
	Port           int          `json:"port"`
	Database       string       `json:"database"`
	Username       string       `json:"username"`
	Password       string       `json:"password"` // encrypted
	Tags           []string     `json:"tags,omitempty"`
	VisibleSchemas []string     `json:"visible_schemas"`
	RedisConfig    *RedisConfig `json:"redis_config,omitempty"`
}

type AppConfig struct {
	mu            sync.RWMutex
	Connections   []ConnectionConfig `json:"connections"`
	EncryptionKey string             `json:"encryption_key"`
	path          string
}

func Load(path string) (*AppConfig, error) {
	cfg := &AppConfig{path: path}

	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return cfg, nil
		}
		return nil, err
	}

	if err := json.Unmarshal(data, cfg); err != nil {
		return nil, err
	}
	cfg.path = path
	return cfg, nil
}

func cloneConnection(conn ConnectionConfig) ConnectionConfig {
	clone := conn
	clone.Tags = slices.Clone(conn.Tags)
	clone.VisibleSchemas = slices.Clone(conn.VisibleSchemas)
	clone.RedisConfig = conn.RedisConfig.Clone()
	return clone
}

func (c *AppConfig) Save(path string) error {
	c.mu.RLock()
	defer c.mu.RUnlock()

	data, err := json.MarshalIndent(c, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, data, 0600)
}

func (c *AppConfig) GetPath() string {
	return c.path
}

func (c *AppConfig) AddConnection(conn ConnectionConfig) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.Connections = append(c.Connections, cloneConnection(conn))
}

func (c *AppConfig) RemoveConnection(id string) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	for i, conn := range c.Connections {
		if conn.ID == id {
			c.Connections = append(c.Connections[:i], c.Connections[i+1:]...)
			return true
		}
	}
	return false
}

func (c *AppConfig) GetConnection(id string) (ConnectionConfig, bool) {
	c.mu.RLock()
	defer c.mu.RUnlock()
	for _, conn := range c.Connections {
		if conn.ID == id {
			return cloneConnection(conn), true
		}
	}
	return ConnectionConfig{}, false
}

func (c *AppConfig) UpdateConnection(id string, updated ConnectionConfig) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	for i, conn := range c.Connections {
		if conn.ID == id {
			c.Connections[i] = cloneConnection(updated)
			return true
		}
	}
	return false
}

func (c *AppConfig) GetConnections() []ConnectionConfig {
	c.mu.RLock()
	defer c.mu.RUnlock()
	result := make([]ConnectionConfig, len(c.Connections))
	for i, conn := range c.Connections {
		result[i] = cloneConnection(conn)
	}
	return result
}
