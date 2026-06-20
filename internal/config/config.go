package config

import (
	"encoding/json"
	"os"
	"slices"
	"strings"
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
	ReadOnly       bool         `json:"read_only,omitempty"`
	RedisConfig    *RedisConfig `json:"redis_config,omitempty"`
	KafkaConfig    *KafkaConfig `json:"kafka_config,omitempty"`
}

type LinkConfig struct {
	ID   string `json:"id"`
	Name string `json:"name,omitempty"`
	// SOURCE
	SourceConnID  string `json:"source_conn_id"`
	SourceKind    string `json:"source_kind,omitempty"`    // "kafka" | "redis" | "postgres"
	SourceScope   string `json:"source_scope,omitempty"`   // kafka: topic; postgres: table; redis: key_pattern
	SourceField   string `json:"source_field,omitempty"`   // kafka: json-path; postgres: column; redis: hash-field/json-path
	SourceExtract string `json:"source_extract,omitempty"` // redis only: value_field|key_capture|string_value
	// TARGET
	TargetConnID string `json:"target_conn_id"`
	TargetKind   string `json:"target_kind"` // "kafka" | "redis" | "postgres"
	TargetTopic  string `json:"target_topic,omitempty"`
	TargetField  string `json:"target_field,omitempty"`
	KeyPattern   string `json:"key_pattern,omitempty"`
	Table        string `json:"table,omitempty"`
	Column       string `json:"column,omitempty"`
	// Deprecated v1 fields kept for backward-compat reads of older config.json.
	Topic string `json:"topic,omitempty"`
	Field string `json:"field,omitempty"`
}

type AppConfig struct {
	mu            sync.RWMutex
	Connections   []ConnectionConfig `json:"connections"`
	Links         []LinkConfig       `json:"links,omitempty"`
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
	clone.KafkaConfig = conn.KafkaConfig.Clone()
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

// SetPathForTest sets the on-disk config path. Intended for tests.
func (c *AppConfig) SetPathForTest(path string) {
	c.path = path
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

func cloneLink(link LinkConfig) LinkConfig {
	return link // LinkConfig has only value fields; a copy is a deep clone
}

// normalizeLink upgrades a v1 (kafka-only) link shape to the v2 generalized
// fields so older config.json files keep working.
func normalizeLink(link LinkConfig) LinkConfig {
	if link.SourceKind == "" {
		link.SourceKind = "kafka"
		if link.SourceScope == "" {
			link.SourceScope = link.Topic
		}
		if link.SourceField == "" {
			link.SourceField = link.Field
		}
	}
	return link
}

func linkScopeMatches(link LinkConfig, object string) bool {
	if link.SourceKind == "redis" {
		return redisPatternMatches(link.SourceScope, object)
	}
	return link.SourceScope == object
}

// redisPatternMatches matches a key against a "prefix*suffix" pattern (one '*').
func redisPatternMatches(pattern, key string) bool {
	star := strings.Index(pattern, "*")
	if star < 0 {
		return pattern == key
	}
	prefix := pattern[:star]
	suffix := pattern[star+1:]
	return len(key) >= len(prefix)+len(suffix) && strings.HasPrefix(key, prefix) && strings.HasSuffix(key, suffix)
}

func (c *AppConfig) AddLink(link LinkConfig) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.Links = append(c.Links, cloneLink(link))
}

func (c *AppConfig) RemoveLink(id string) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	for i, link := range c.Links {
		if link.ID == id {
			c.Links = append(c.Links[:i], c.Links[i+1:]...)
			return true
		}
	}
	return false
}

func (c *AppConfig) GetLinks() []LinkConfig {
	c.mu.RLock()
	defer c.mu.RUnlock()
	result := make([]LinkConfig, len(c.Links))
	for i, link := range c.Links {
		result[i] = normalizeLink(cloneLink(link))
	}
	return result
}

func (c *AppConfig) GetLinksFor(sourceConnID, scope string) []LinkConfig {
	c.mu.RLock()
	defer c.mu.RUnlock()
	result := make([]LinkConfig, 0)
	for _, link := range c.Links {
		normalized := normalizeLink(cloneLink(link))
		if normalized.SourceConnID == sourceConnID && linkScopeMatches(normalized, scope) {
			result = append(result, normalized)
		}
	}
	return result
}
