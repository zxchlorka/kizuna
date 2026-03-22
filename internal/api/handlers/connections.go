package handlers

import (
	"crypto/rand"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
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
		ID       string `json:"id"`
		Name     string `json:"name"`
		Type     string `json:"type"`
		Host     string `json:"host"`
		Port     int    `json:"port"`
		Database string `json:"database"`
		Username string `json:"username"`
	}

	result := make([]connResponse, len(conns))
	for i, c := range conns {
		result[i] = connResponse{
			ID:       c.ID,
			Name:     c.Name,
			Type:     c.Type,
			Host:     c.Host,
			Port:     c.Port,
			Database: c.Database,
			Username: c.Username,
		}
	}

	writeJSON(w, http.StatusOK, result)
}

func (h *ConnectionsHandler) Create(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Name     string `json:"name"`
		Type     string `json:"type"`
		Host     string `json:"host"`
		Port     int    `json:"port"`
		Database string `json:"database"`
		Username string `json:"username"`
		Password string `json:"password"`
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
		Password: encPassword,
	}

	h.cfg.AddConnection(conn)

	if err := h.cfg.Save(h.cfg.GetPath()); err != nil {
		slog.Error("failed to save config", "error", err)
		writeError(w, http.StatusInternalServerError, "failed to save configuration")
		return
	}

	writeJSON(w, http.StatusCreated, map[string]any{
		"id":       conn.ID,
		"name":     conn.Name,
		"type":     conn.Type,
		"host":     conn.Host,
		"port":     conn.Port,
		"database": conn.Database,
		"username": conn.Username,
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
		Name     *string `json:"name"`
		Type     *string `json:"type"`
		Host     *string `json:"host"`
		Port     *int    `json:"port"`
		Database *string `json:"database"`
		Username *string `json:"username"`
		Password *string `json:"password"`
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
	if req.Password != nil && *req.Password != "" {
		encrypted, err := config.Encrypt(h.cfg.EncryptionKey, *req.Password)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "failed to encrypt password")
			return
		}
		existing.Password = encrypted
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
		"id":       existing.ID,
		"name":     existing.Name,
		"type":     existing.Type,
		"host":     existing.Host,
		"port":     existing.Port,
		"database": existing.Database,
		"username": existing.Username,
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

	c, err := h.manager.Get(id)
	if err != nil {
		writeJSON(w, http.StatusOK, map[string]any{"ok": false, "error": err.Error()})
		return
	}

	start := time.Now()
	err = c.Ping(r.Context())
	latency := time.Since(start).Milliseconds()

	if err != nil {
		writeJSON(w, http.StatusOK, map[string]any{"ok": false, "error": err.Error()})
		return
	}

	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "latency_ms": latency})
}

func (h *ConnectionsHandler) Info(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")

	c, err := h.manager.Get(id)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}

	info, err := c.GetInfo(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}

	writeJSON(w, http.StatusOK, info)
}

func generateID() string {
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}

func writeJSON(w http.ResponseWriter, code int, data any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	json.NewEncoder(w).Encode(data)
}

func writeError(w http.ResponseWriter, code int, msg string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	json.NewEncoder(w).Encode(map[string]any{"error": msg, "code": code})
}
