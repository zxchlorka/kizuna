package handlers

import (
	"encoding/json"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/zxchlorka/kizuna/internal/config"
	"github.com/zxchlorka/kizuna/internal/connector"
)

type DDLHandler struct {
	cfg     *config.AppConfig
	manager *connector.ConnectionManager
}

func NewDDLHandler(cfg *config.AppConfig, manager *connector.ConnectionManager) *DDLHandler {
	return &DDLHandler{cfg: cfg, manager: manager}
}

func (h *DDLHandler) Execute(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")

	var op connector.DDLOp
	if err := json.NewDecoder(r.Body).Decode(&op); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body: "+err.Error())
		return
	}
	if op.Type == "" || op.Schema == "" || op.Object == "" {
		writeError(w, http.StatusBadRequest, "type, schema, and object are required")
		return
	}
	if isDangerousDDLOp(op.Type) {
		w.Header().Set("X-Dangerous", "true")
	}

	conn, err := h.manager.Get(r.Context(), id)
	if err != nil {
		writeConnectorError(w, err)
		return
	}
	if err := conn.DDL(r.Context(), op); err != nil {
		writeConnectorError(w, err)
		return
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"ok":     true,
		"type":   op.Type,
		"schema": op.Schema,
		"object": op.Object,
	})
}

func isDangerousDDLOp(opType string) bool {
	switch opType {
	case "drop_table", "drop_column", "drop_index":
		return true
	default:
		return false
	}
}
