package handlers

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"strconv"

	"github.com/go-chi/chi/v5"
	"github.com/zxchlorka/kizuna/internal/config"
	"github.com/zxchlorka/kizuna/internal/connector"
)

type DataHandler struct {
	cfg     *config.AppConfig
	manager *connector.ConnectionManager
}

type CreateKeyRequest struct {
	Key   string `json:"key"`
	Type  string `json:"type"`
	Value any    `json:"value"`
	TTL   *int64 `json:"ttl,omitempty"`
}

func NewDataHandler(cfg *config.AppConfig, manager *connector.ConnectionManager) *DataHandler {
	return &DataHandler{cfg: cfg, manager: manager}
}

func (h *DataHandler) GetData(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	name, err := url.PathUnescape(chi.URLParam(r, "name")) // "schema.table" or redis key path
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid object name")
		return
	}

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

	if op.Object == "" {
		writeError(w, http.StatusBadRequest, "object is required")
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

func (h *DataHandler) CreateKey(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")

	var req CreateKeyRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body: "+err.Error())
		return
	}

	if req.Key == "" || req.Type == "" {
		writeError(w, http.StatusBadRequest, "key and type are required")
		return
	}

	data := map[string]any{
		"type":  req.Type,
		"value": req.Value,
	}
	if req.TTL != nil {
		data["ttl"] = *req.TTL
	}

	conn, cancel, err := getConnector(r.Context(), h.manager, id)
	if err != nil {
		writeConnectorError(w, err)
		return
	}
	defer cancel()

	result, err := conn.Mutate(r.Context(), connector.MutateOp{
		Type:   "insert",
		Schema: "",
		Object: req.Key,
		Data:   data,
	})
	if err != nil {
		writeConnectorError(w, err)
		return
	}

	writeJSON(w, http.StatusCreated, result)
}

// Produce publishes a batch of messages to a Kafka topic. Loop/multi template
// expansion happens client-side; this endpoint receives the expanded batch.
func (h *DataHandler) Produce(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")

	var req connector.KafkaProduceRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body: "+err.Error())
		return
	}

	conn, cancel, err := getConnector(r.Context(), h.manager, id)
	if err != nil {
		writeConnectorError(w, err)
		return
	}
	defer cancel()

	producer, ok := conn.(connector.KafkaProducer)
	if !ok {
		writeError(w, http.StatusBadRequest, "producing is not supported for this connection")
		return
	}

	result, err := producer.Produce(r.Context(), req)
	if err != nil {
		writeConnectorError(w, err)
		return
	}

	writeJSON(w, http.StatusOK, result)
}
