package handlers

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"slices"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/qsnake66/infraview/internal/config"
	"github.com/qsnake66/infraview/internal/connector"
)

type ConnectionsHandler struct {
	cfg     *config.AppConfig
	manager *connector.ConnectionManager
}

type connectionRequest struct {
	ID             string              `json:"id"`
	Name           string              `json:"name"`
	Type           string              `json:"type"`
	Host           string              `json:"host"`
	Port           int                 `json:"port"`
	Database       string              `json:"database"`
	Username       string              `json:"username"`
	Tags           []string            `json:"tags"`
	Password       string              `json:"password"`
	VisibleSchemas []string            `json:"visible_schemas"`
	RedisConfig    *config.RedisConfig `json:"redis_config"`
}

type connectionResponse struct {
	ID               string              `json:"id"`
	Name             string              `json:"name"`
	Type             string              `json:"type"`
	Host             string              `json:"host"`
	Port             int                 `json:"port"`
	Database         string              `json:"database"`
	Username         string              `json:"username"`
	Tags             []string            `json:"tags,omitempty"`
	VisibleSchemas   []string            `json:"visible_schemas"`
	RedisConfig      *config.RedisConfig `json:"redis_config,omitempty"`
	Mode             config.RedisMode    `json:"mode,omitempty"`
	Separator        string              `json:"separator,omitempty"`
	TLSEnabled       bool                `json:"tlsEnabled,omitempty"`
	MasterName       string              `json:"masterName,omitempty"`
	ClusterAddresses []string            `json:"clusterAddresses,omitempty"`
	SentinelAddrs    []string            `json:"sentinelAddresses,omitempty"`
}

func NewConnectionsHandler(cfg *config.AppConfig, manager *connector.ConnectionManager) *ConnectionsHandler {
	return &ConnectionsHandler{cfg: cfg, manager: manager}
}

func (h *ConnectionsHandler) List(w http.ResponseWriter, r *http.Request) {
	conns := h.cfg.GetConnections()

	result := make([]connectionResponse, len(conns))
	for i, c := range conns {
		result[i] = buildConnectionResponse(c)
	}

	writeJSON(w, http.StatusOK, result)
}

func (h *ConnectionsHandler) Create(w http.ResponseWriter, r *http.Request) {
	var req connectionRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}

	if err := validateConnectionRequest(req); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}

	// Encrypt password
	encPassword := ""
	if req.Password != "" {
		encrypted, err := config.Encrypt(h.cfg.EncryptionKey, req.Password)
		if err != nil {
			slog.Error("failed to encrypt password", "error", err)
			writeError(w, http.StatusInternalServerError, "failed to encrypt password")
			return
		}
		encPassword = encrypted
	}

	// Generate UUID
	id := generateID()

	conn := buildConnectionConfig(req, encPassword)
	conn.ID = id

	h.cfg.AddConnection(conn)

	if err := h.cfg.Save(h.cfg.GetPath()); err != nil {
		slog.Error("failed to save config", "error", err)
		writeError(w, http.StatusInternalServerError, "failed to save configuration")
		return
	}

	writeJSON(w, http.StatusCreated, buildConnectionResponse(conn))
}

func (h *ConnectionsHandler) TestConfig(w http.ResponseWriter, r *http.Request) {
	var req connectionRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}

	if err := validateConnectionRequest(req); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}

	password := req.Password
	if password == "" && req.ID != "" {
		existing, ok := h.cfg.GetConnection(req.ID)
		if !ok {
			writeError(w, http.StatusNotFound, "connection not found")
			return
		}
		password = existing.Password
	} else if password != "" {
		encrypted, err := config.Encrypt(h.cfg.EncryptionKey, password)
		if err != nil {
			slog.Error("failed to encrypt transient password", "error", err)
			writeError(w, http.StatusInternalServerError, "failed to encrypt password")
			return
		}
		password = encrypted
	}

	cfg := buildConnectionConfig(req, password)

	start := time.Now()
	if err := h.testTransientConnection(r.Context(), cfg); err != nil {
		writeConnectorError(w, err)
		return
	}

	latency := time.Since(start).Milliseconds()
	logSlowConnectionCheck("test-config", req.Type, req.Host, req.Database, latency)

	writeJSON(w, http.StatusOK, map[string]any{
		"ok":         true,
		"latency_ms": latency,
	})
}

func (h *ConnectionsHandler) Update(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")

	existing, ok := h.cfg.GetConnection(id)
	if !ok {
		writeError(w, http.StatusNotFound, "connection not found")
		return
	}

	var req struct {
		Name        *string             `json:"name"`
		Type        *string             `json:"type"`
		Host        *string             `json:"host"`
		Port        *int                `json:"port"`
		Database    *string             `json:"database"`
		Username    *string             `json:"username"`
		Tags        *[]string           `json:"tags"`
		Password    *string             `json:"password"`
		RedisConfig *config.RedisConfig `json:"redis_config"`
	}

	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}

	if req.Name != nil {
		existing.Name = *req.Name
	}
	if req.Type != nil {
		existing.Type = *req.Type
	}
	if req.Host != nil {
		existing.Host = *req.Host
	}
	if req.Port != nil {
		existing.Port = *req.Port
	}
	if req.Database != nil {
		existing.Database = *req.Database
	}
	if req.Username != nil {
		existing.Username = *req.Username
	}
	if req.Tags != nil {
		existing.Tags = normalizeTags(*req.Tags)
	}
	if req.Password != nil && *req.Password != "" {
		encrypted, err := config.Encrypt(h.cfg.EncryptionKey, *req.Password)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "failed to encrypt password")
			return
		}
		existing.Password = encrypted
	}
	if req.RedisConfig != nil {
		existing.RedisConfig = req.RedisConfig.Clone()
		if existing.RedisConfig != nil {
			normalized := existing.RedisConfig.Normalize()
			existing.RedisConfig = &normalized
		}
	}
	if existing.Type != "redis" {
		existing.RedisConfig = nil
	}

	h.cfg.UpdateConnection(id, existing)

	// Remove cached connector so it reconnects with new config
	h.manager.Remove(id)

	if err := h.cfg.Save(h.cfg.GetPath()); err != nil {
		slog.Error("failed to save config", "error", err)
		writeError(w, http.StatusInternalServerError, "failed to save configuration")
		return
	}

	writeJSON(w, http.StatusOK, buildConnectionResponse(existing))
}

func (h *ConnectionsHandler) UpdateVisibleSchemas(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")

	existing, ok := h.cfg.GetConnection(id)
	if !ok {
		writeError(w, http.StatusNotFound, "connection not found")
		return
	}

	var req struct {
		VisibleSchemas []string `json:"visible_schemas"`
	}

	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}

	existing.VisibleSchemas = normalizeVisibleSchemas(req.VisibleSchemas)
	h.cfg.UpdateConnection(id, existing)

	if err := h.cfg.Save(h.cfg.GetPath()); err != nil {
		slog.Error("failed to save config", "error", err)
		writeError(w, http.StatusInternalServerError, "failed to save configuration")
		return
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"id":              existing.ID,
		"visible_schemas": existing.VisibleSchemas,
	})
}

func (h *ConnectionsHandler) Delete(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")

	if !h.cfg.RemoveConnection(id) {
		writeError(w, http.StatusNotFound, "connection not found")
		return
	}

	h.manager.Remove(id)

	if err := h.cfg.Save(h.cfg.GetPath()); err != nil {
		slog.Error("failed to save config", "error", err)
		writeError(w, http.StatusInternalServerError, "failed to save configuration")
		return
	}

	w.WriteHeader(http.StatusNoContent)
}

func (h *ConnectionsHandler) Test(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	start := time.Now()

	c, cancel, err := getConnector(r.Context(), h.manager, id)
	if err != nil {
		writeConnectorError(w, err)
		return
	}
	defer cancel()

	pingCtx, pingCancel := context.WithTimeout(r.Context(), connectionAcquireTimeout)
	defer pingCancel()

	if err := c.Ping(pingCtx); err != nil {
		writeConnectorError(w, err)
		return
	}

	latency := time.Since(start).Milliseconds()
	connCfg, _ := h.cfg.GetConnection(id)
	logSlowConnectionCheck("test", connCfg.Type, connCfg.Host, connCfg.Database, latency)

	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "latency_ms": latency})
}

func (h *ConnectionsHandler) Info(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")

	c, cancel, err := getConnector(r.Context(), h.manager, id)
	if err != nil {
		writeConnectorError(w, err)
		return
	}
	defer cancel()

	info, err := c.GetInfo(r.Context())
	if err != nil {
		writeConnectorError(w, err)
		return
	}

	writeJSON(w, http.StatusOK, info)
}

func generateID() string {
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}

func normalizeTags(tags []string) []string {
	if len(tags) == 0 {
		return nil
	}

	seen := make(map[string]struct{}, len(tags))
	out := make([]string, 0, len(tags))
	for _, tag := range tags {
		normalized := strings.ToLower(strings.TrimSpace(tag))
		if normalized == "" {
			continue
		}
		if _, ok := seen[normalized]; ok {
			continue
		}
		seen[normalized] = struct{}{}
		out = append(out, normalized)
	}
	slices.Sort(out)
	if len(out) == 0 {
		return nil
	}
	return out
}

func normalizeVisibleSchemas(schemas []string) []string {
	if len(schemas) == 0 {
		return nil
	}

	seen := make(map[string]struct{}, len(schemas))
	out := make([]string, 0, len(schemas))
	for _, schema := range schemas {
		normalized := strings.TrimSpace(schema)
		if normalized == "" {
			continue
		}
		if _, ok := seen[normalized]; ok {
			continue
		}
		seen[normalized] = struct{}{}
		out = append(out, normalized)
	}
	slices.Sort(out)
	if len(out) == 0 {
		return nil
	}
	return out
}

func (h *ConnectionsHandler) testTransientConnection(ctx context.Context, cfg config.ConnectionConfig) error {
	factory, ok := h.managerFactory(cfg.Type)
	if !ok {
		return fmt.Errorf("unsupported connection type: %s", cfg.Type)
	}

	timeoutCtx, cancel := context.WithTimeout(ctx, connectionAcquireTimeout)
	defer cancel()

	conn, err := factory(timeoutCtx, cfg, h.cfg.EncryptionKey)
	if err != nil {
		return err
	}
	defer conn.Close()

	return nil
}

func (h *ConnectionsHandler) managerFactory(connType string) (connector.ConnectorFactory, bool) {
	return h.manager.Factory(connType)
}

func buildConnectionConfig(req connectionRequest, password string) config.ConnectionConfig {
	cfg := config.ConnectionConfig{
		ID:             req.ID,
		Name:           req.Name,
		Type:           req.Type,
		Host:           req.Host,
		Port:           req.Port,
		Database:       req.Database,
		Username:       req.Username,
		Password:       password,
		Tags:           normalizeTags(req.Tags),
		VisibleSchemas: normalizeVisibleSchemas(req.VisibleSchemas),
	}
	if req.RedisConfig != nil {
		cfg.RedisConfig = req.RedisConfig.Clone()
		if cfg.RedisConfig != nil {
			normalized := cfg.RedisConfig.Normalize()
			cfg.RedisConfig = &normalized
		}
	}
	return cfg
}

func buildConnectionResponse(conn config.ConnectionConfig) connectionResponse {
	resp := connectionResponse{
		ID:             conn.ID,
		Name:           conn.Name,
		Type:           conn.Type,
		Host:           conn.Host,
		Port:           conn.Port,
		Database:       conn.Database,
		Username:       conn.Username,
		Tags:           slices.Clone(conn.Tags),
		VisibleSchemas: slices.Clone(conn.VisibleSchemas),
		RedisConfig:    conn.RedisConfig.Clone(),
	}
	if conn.RedisConfig != nil {
		resp.Mode = conn.RedisConfig.Mode
		resp.Separator = conn.RedisConfig.Separator
		resp.TLSEnabled = conn.RedisConfig.TLSEnabled
		resp.MasterName = conn.RedisConfig.MasterName
		resp.ClusterAddresses = slices.Clone(conn.RedisConfig.Addresses)
		resp.SentinelAddrs = slices.Clone(conn.RedisConfig.SentinelAddrs)
	}
	return resp
}

func validateConnectionRequest(req connectionRequest) error {
	if strings.TrimSpace(req.Name) == "" {
		return fmt.Errorf("name is required")
	}
	if strings.TrimSpace(req.Type) == "" {
		return fmt.Errorf("type is required")
	}

	switch req.Type {
	case "postgres":
		if strings.TrimSpace(req.Host) == "" || req.Port <= 0 || strings.TrimSpace(req.Database) == "" || strings.TrimSpace(req.Username) == "" {
			return fmt.Errorf("postgres requires host, port, database, and username")
		}
	case "redis":
		redisCfg := config.RedisConfig{}
		if req.RedisConfig != nil {
			redisCfg = req.RedisConfig.Normalize()
		}
		switch redisCfg.Mode {
		case "", config.RedisModeStandalone:
			if strings.TrimSpace(req.Host) == "" || req.Port <= 0 {
				return fmt.Errorf("redis standalone requires host and port")
			}
		case config.RedisModeCluster:
			if len(redisCfg.Addresses) == 0 && (strings.TrimSpace(req.Host) == "" || req.Port <= 0) {
				return fmt.Errorf("redis cluster requires broker addresses")
			}
		case config.RedisModeSentinel:
			if strings.TrimSpace(redisCfg.MasterName) == "" {
				return fmt.Errorf("redis sentinel requires master_name")
			}
			if len(redisCfg.SentinelAddrs) == 0 && (strings.TrimSpace(req.Host) == "" || req.Port <= 0) {
				return fmt.Errorf("redis sentinel requires sentinel addresses")
			}
		default:
			return fmt.Errorf("unsupported redis mode: %s", redisCfg.Mode)
		}
	default:
		return fmt.Errorf("unsupported connection type: %s", req.Type)
	}

	return nil
}

func logSlowConnectionCheck(kind, connType, host, database string, latencyMs int64) {
	if latencyMs < 250 {
		return
	}

	slog.Info("slow connection check",
		"kind", kind,
		"type", connType,
		"host", host,
		"database", database,
		"latency_ms", latencyMs,
	)
}
