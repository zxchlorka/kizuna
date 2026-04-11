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

func NewConnectionsHandler(cfg *config.AppConfig, manager *connector.ConnectionManager) *ConnectionsHandler {
	return &ConnectionsHandler{cfg: cfg, manager: manager}
}

func (h *ConnectionsHandler) List(w http.ResponseWriter, r *http.Request) {
	conns := h.cfg.GetConnections()

	// Omit password from response
	type connResponse struct {
		ID          string              `json:"id"`
		Name        string              `json:"name"`
		Type        string              `json:"type"`
		Host        string              `json:"host"`
		Port        int                 `json:"port"`
		Database    string              `json:"database"`
		Username    string              `json:"username"`
		Tags        []string            `json:"tags,omitempty"`
		RedisConfig *config.RedisConfig `json:"redis_config,omitempty"`
	}

	result := make([]connResponse, len(conns))
	for i, c := range conns {
		result[i] = connResponse{
			ID:          c.ID,
			Name:        c.Name,
			Type:        c.Type,
			Host:        c.Host,
			Port:        c.Port,
			Database:    c.Database,
			Username:    c.Username,
			Tags:        slices.Clone(c.Tags),
			RedisConfig: c.RedisConfig.Clone(),
		}
	}

	writeJSON(w, http.StatusOK, result)
}

func (h *ConnectionsHandler) Create(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Name        string              `json:"name"`
		Type        string              `json:"type"`
		Host        string              `json:"host"`
		Port        int                 `json:"port"`
		Database    string              `json:"database"`
		Username    string              `json:"username"`
		Tags        []string            `json:"tags"`
		Password    string              `json:"password"`
		RedisConfig *config.RedisConfig `json:"redis_config"`
	}

	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}

	if req.Name == "" || req.Type == "" || req.Host == "" {
		writeError(w, http.StatusBadRequest, "name, type, and host are required")
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

	conn := config.ConnectionConfig{
		ID:       id,
		Name:     req.Name,
		Type:     req.Type,
		Host:     req.Host,
		Port:     req.Port,
		Database: req.Database,
		Username: req.Username,
		Tags:     normalizeTags(req.Tags),
		Password: encPassword,
	}
	if req.RedisConfig != nil {
		conn.RedisConfig = req.RedisConfig.Clone()
	}

	h.cfg.AddConnection(conn)

	if err := h.cfg.Save(h.cfg.GetPath()); err != nil {
		slog.Error("failed to save config", "error", err)
		writeError(w, http.StatusInternalServerError, "failed to save configuration")
		return
	}

	writeJSON(w, http.StatusCreated, map[string]any{
		"id":           conn.ID,
		"name":         conn.Name,
		"type":         conn.Type,
		"host":         conn.Host,
		"port":         conn.Port,
		"database":     conn.Database,
		"username":     conn.Username,
		"tags":         conn.Tags,
		"redis_config": conn.RedisConfig,
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
	}

	h.cfg.UpdateConnection(id, existing)

	// Remove cached connector so it reconnects with new config
	h.manager.Remove(id)

	if err := h.cfg.Save(h.cfg.GetPath()); err != nil {
		slog.Error("failed to save config", "error", err)
		writeError(w, http.StatusInternalServerError, "failed to save configuration")
		return
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"id":           existing.ID,
		"name":         existing.Name,
		"type":         existing.Type,
		"host":         existing.Host,
		"port":         existing.Port,
		"database":     existing.Database,
		"username":     existing.Username,
		"tags":         existing.Tags,
		"redis_config": existing.RedisConfig,
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
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()

	c, err := h.manager.Get(ctx, id)
	if err != nil {
		writeConnectorError(w, err)
		return
	}

	start := time.Now()
	err = c.Ping(ctx)
	latency := time.Since(start).Milliseconds()

	if err != nil {
		writeConnectorError(w, err)
		return
	}

	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "latency_ms": latency})
}

func (h *ConnectionsHandler) Info(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")

	c, err := h.manager.Get(r.Context(), id)
	if err != nil {
		writeConnectorError(w, err)
		return
	}

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
