package config

import (
	"encoding/base64"
	"encoding/json"
	"os"
	"slices"
	"strings"
	"sync"
	"unicode/utf8"
)

type ConnectionConfig struct {
	ID             string   `json:"id"`
	Name           string   `json:"name"`
	Type           string   `json:"type"` // "postgres", "redis", "kafka"
	Host           string   `json:"host"`
	Port           int      `json:"port"`
	Database       string   `json:"database"`
	Username       string   `json:"username"`
	Password       string   `json:"password"` // encrypted
	Tags           []string `json:"tags,omitempty"`
	VisibleSchemas []string `json:"visible_schemas"`
	ReadOnly       bool     `json:"read_only,omitempty"`
	FolderID       string   `json:"folder_id,omitempty"` // "" = top level
	// Position orders connections inside their folder, from 1; 0 (never
	// arranged) sorts after every arranged one, in config order.
	Position       int             `json:"position,omitempty"`
	PostgresConfig *PostgresConfig `json:"postgres_config,omitempty"`
	RedisConfig    *RedisConfig    `json:"redis_config,omitempty"`
	KafkaConfig    *KafkaConfig    `json:"kafka_config,omitempty"`
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
	Folders       []FolderConfig     `json:"folders,omitempty"`
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
	cfg.normalizeFolders()
	return cfg, nil
}

func cloneConnection(conn ConnectionConfig) ConnectionConfig {
	clone := conn
	clone.Tags = slices.Clone(conn.Tags)
	clone.VisibleSchemas = slices.Clone(conn.VisibleSchemas)
	clone.PostgresConfig = conn.PostgresConfig.Clone()
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

func (c *AppConfig) AddConnection(conn ConnectionConfig) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.Connections = append(c.Connections, cloneConnection(conn))
}

// RemoveConnectionCascade removes the connection with the given id together with
// every cross-source link that references it as source or target, as one
// mutation under a single lock. It reports whether the connection existed and
// the ids of the links removed along with it.
//
// The cascade is deliberately NOT implemented by calling RemoveLink in a loop:
// RemoveLink takes the same mutex, so that would self-deadlock. A self-link
// (source and target both this connection) matches the first branch and is
// therefore removed exactly once.
func (c *AppConfig) RemoveConnectionCascade(id string) (bool, []string) {
	c.mu.Lock()
	defer c.mu.Unlock()

	removed := false
	for i, conn := range c.Connections {
		if conn.ID == id {
			c.Connections = append(c.Connections[:i], c.Connections[i+1:]...)
			removed = true
			break
		}
	}
	if !removed {
		return false, nil
	}

	var removedLinkIDs []string
	kept := make([]LinkConfig, 0, len(c.Links))
	for _, link := range c.Links {
		if link.SourceConnID == id || link.TargetConnID == id || IsDatabaseOf(link.SourceConnID, id) || IsDatabaseOf(link.TargetConnID, id) {
			removedLinkIDs = append(removedLinkIDs, link.ID)
			continue
		}
		kept = append(kept, link)
	}
	c.Links = kept
	return true, removedLinkIDs
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

// DatabaseIDSeparator joins a postgres connection id and a database name into
// the id of a connection that exists only at runtime: the same server and
// credentials pointed at another database. Nothing is stored for it, so it
// always follows its parent's current host and password and dies with it.
//
// The database name is unpadded base64url (see DatabaseConnectionID): the id
// travels in URL paths, where a raw "a/b" or "q?1" would cut the route.
const DatabaseIDSeparator = "~"

// DatabaseConnectionID builds the runtime id of database on parentID's server.
func DatabaseConnectionID(parentID, database string) string {
	return parentID + DatabaseIDSeparator + base64.RawURLEncoding.EncodeToString([]byte(database))
}

// IsDatabaseOf reports whether id is a runtime database connection of parentID.
func IsDatabaseOf(id, parentID string) bool {
	return strings.HasPrefix(id, parentID+DatabaseIDSeparator)
}

// ResolveConnection is GetConnection that also understands runtime database
// ids. Read paths (opening a connector, listing databases) use it; mutations
// keep using GetConnection, so a runtime id can never be edited or deleted.
func (c *AppConfig) ResolveConnection(id string) (ConnectionConfig, bool) {
	if conn, ok := c.GetConnection(id); ok {
		return conn, true
	}
	parentID, encoded, ok := strings.Cut(id, DatabaseIDSeparator)
	if !ok {
		return ConnectionConfig{}, false
	}
	raw, err := base64.RawURLEncoding.DecodeString(encoded)
	database := string(raw)
	if err != nil || database == "" || !utf8.ValidString(database) {
		return ConnectionConfig{}, false
	}
	parent, ok := c.GetConnection(parentID)
	if !ok || parent.Type != "postgres" {
		return ConnectionConfig{}, false
	}
	parent.ID = id
	parent.Name = parent.Name + " · " + database
	parent.Database = database
	// The parent's schema filter names schemas of its own database.
	parent.VisibleSchemas = nil
	return parent, true
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
	c.Links = append(c.Links, link)
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

// UpdateLink replaces the link with the given id, preserving the id. Returns
// false if no link with that id exists.
func (c *AppConfig) UpdateLink(id string, link LinkConfig) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	for i, existing := range c.Links {
		if existing.ID == id {
			link.ID = id
			c.Links[i] = link
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
		result[i] = normalizeLink(link)
	}
	return result
}

func (c *AppConfig) GetLinksFor(sourceConnID, scope string) []LinkConfig {
	c.mu.RLock()
	defer c.mu.RUnlock()
	result := make([]LinkConfig, 0)
	for _, link := range c.Links {
		normalized := normalizeLink(link)
		if normalized.SourceConnID == sourceConnID && linkScopeMatches(normalized, scope) {
			result = append(result, normalized)
		}
	}
	return result
}
