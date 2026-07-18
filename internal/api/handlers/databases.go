package handlers

import (
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"slices"
	"strings"

	"github.com/go-chi/chi/v5"
)

const listDatabasesQuery = `SELECT datname FROM pg_database WHERE NOT datistemplate AND has_database_privilege(datname, 'CONNECT') ORDER BY datname`

// Databases lists the databases available on the server behind a postgres
// connection, so the UI can offer switching between sibling databases.
func (h *ConnectionsHandler) Databases(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")

	connCfg, ok := h.cfg.GetConnection(id)
	if !ok {
		writeError(w, http.StatusNotFound, "connection not found")
		return
	}
	if connCfg.Type != "postgres" {
		writeError(w, http.StatusBadRequest, "database listing is only supported for postgres connections")
		return
	}

	c, cancel, err := getConnector(r.Context(), h.manager, id)
	if err != nil {
		writeConnectorError(w, err)
		return
	}
	defer cancel()

	result, err := c.Execute(r.Context(), listDatabasesQuery)
	if err != nil {
		writeConnectorError(w, err)
		return
	}
	if result.Error != "" {
		writeError(w, http.StatusInternalServerError, result.Error)
		return
	}

	databases := make([]string, 0, len(result.Rows))
	for _, row := range result.Rows {
		if len(row) == 0 || row[0] == nil {
			continue
		}
		databases = append(databases, fmt.Sprint(row[0]))
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"current":   connCfg.Database,
		"databases": databases,
	})
}

type duplicateConnectionRequest struct {
	Database string `json:"database"`
}

// Duplicate creates a sibling connection pointing at another database on the
// same server. The stored (encrypted) password is copied server-side and never
// leaves the backend. Idempotent: an existing sibling is returned instead of
// creating a duplicate.
func (h *ConnectionsHandler) Duplicate(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")

	var req duplicateConnectionRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	database := strings.TrimSpace(req.Database)
	if database == "" {
		writeError(w, http.StatusBadRequest, "database is required")
		return
	}

	source, ok := h.cfg.GetConnection(id)
	if !ok {
		writeError(w, http.StatusNotFound, "connection not found")
		return
	}
	if source.Type != "postgres" {
		writeError(w, http.StatusBadRequest, "duplicating into another database is only supported for postgres connections")
		return
	}

	if source.Database == database {
		writeJSON(w, http.StatusOK, buildConnectionResponse(source))
		return
	}

	for _, existing := range h.cfg.GetConnections() {
		if existing.Type == source.Type && existing.Host == source.Host && existing.Port == source.Port && existing.Database == database {
			writeJSON(w, http.StatusOK, buildConnectionResponse(existing))
			return
		}
	}

	sibling := source
	sibling.ID = generateID()
	sibling.Database = database
	baseName := strings.TrimSuffix(source.Name, " · "+source.Database)
	sibling.Name = baseName + " · " + database
	sibling.Tags = slices.Clone(source.Tags)
	sibling.VisibleSchemas = slices.Clone(source.VisibleSchemas)

	h.cfg.AddConnection(sibling)
	if err := h.cfg.Save(h.cfg.GetPath()); err != nil {
		slog.Error("failed to save config", "error", err)
		writeError(w, http.StatusInternalServerError, "failed to save configuration")
		return
	}

	writeJSON(w, http.StatusCreated, buildConnectionResponse(sibling))
}
