package handlers

import (
	"encoding/json"
	"errors"
	"net/http"
	"strconv"

	"github.com/go-chi/chi/v5"
	"github.com/qsnake66/infraview/internal/config"
	"github.com/qsnake66/infraview/internal/connector"
)

type DataHandler struct {
	cfg     *config.AppConfig
	manager *connector.ConnectionManager
}

func NewDataHandler(cfg *config.AppConfig, manager *connector.ConnectionManager) *DataHandler {
	return &DataHandler{cfg: cfg, manager: manager}
}

func (h *DataHandler) GetData(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	name := chi.URLParam(r, "name") // "schema.table"

	q := r.URL.Query()

	offset, err := strconv.Atoi(q.Get("offset"))
	if err != nil || offset < 0 {
		offset = 0
	}

	limit, err := strconv.Atoi(q.Get("limit"))
	if err != nil || limit <= 0 {
		limit = 50
	}

	orderBy := q.Get("order_by")
	orderDir := q.Get("order_dir")

	var filters []connector.FilterExpr
	if raw := q.Get("filters"); raw != "" {
		if err := json.Unmarshal([]byte(raw), &filters); err != nil {
			writeError(w, http.StatusBadRequest, "invalid filters JSON: "+err.Error())
			return
		}
	}

	opts := connector.DataOpts{
		Offset:   offset,
		Limit:    limit,
		OrderBy:  orderBy,
		OrderDir: orderDir,
		Filters:  filters,
	}

	conn, cancel, err := getConnector(r.Context(), h.manager, id)
	if err != nil {
		writeConnectorError(w, err)
		return
	}
	defer cancel()

	result, err := conn.GetData(r.Context(), name, opts)
	if err != nil {
		writeConnectorError(w, err)
		return
	}

	writeJSON(w, http.StatusOK, result)
}

func (h *DataHandler) Mutate(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")

	var op connector.MutateOp
	if err := json.NewDecoder(r.Body).Decode(&op); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body: "+err.Error())
		return
	}

	if op.Schema == "" || op.Object == "" {
		writeError(w, http.StatusBadRequest, "schema and object are required")
		return
	}

	conn, cancel, err := getConnector(r.Context(), h.manager, id)
	if err != nil {
		writeConnectorError(w, err)
		return
	}
	defer cancel()

	result, err := conn.Mutate(r.Context(), op)
	if err != nil {
		if errors.Is(err, connector.ErrNotFound) {
			writeError(w, http.StatusConflict, err.Error())
			return
		}
		writeConnectorError(w, err)
		return
	}

	writeJSON(w, http.StatusOK, result)
}

func (h *DataHandler) MutateBulk(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")

	var op connector.BulkMutateOp
	if err := json.NewDecoder(r.Body).Decode(&op); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body: "+err.Error())
		return
	}

	conn, cancel, err := getConnector(r.Context(), h.manager, id)
	if err != nil {
		writeConnectorError(w, err)
		return
	}
	defer cancel()

	result, err := conn.MutateBulk(r.Context(), op)
	if err != nil {
		if errors.Is(err, connector.ErrNotFound) {
			writeError(w, http.StatusConflict, err.Error())
			return
		}
		writeConnectorError(w, err)
		return
	}

	writeJSON(w, http.StatusOK, result)
}
