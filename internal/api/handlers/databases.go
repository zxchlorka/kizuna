package handlers

import (
	"fmt"
	"net/http"

	"github.com/go-chi/chi/v5"
)

const listDatabasesQuery = `SELECT datname FROM pg_database WHERE NOT datistemplate AND has_database_privilege(datname, 'CONNECT') ORDER BY datname`

// Databases lists the databases available on the server behind a postgres
// connection. Switching to one needs no request: the UI addresses it by the
// runtime id config.DatabaseIDSeparator builds, and nothing is saved.
func (h *ConnectionsHandler) Databases(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")

	connCfg, ok := h.cfg.ResolveConnection(id)
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
