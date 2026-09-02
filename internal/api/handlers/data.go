package handlers

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"strconv"
	"strings"

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
	if !decodeJSON(w, r, &op) {
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
	if !decodeJSON(w, r, &op) {
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
	if !decodeJSON(w, r, &req) {
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
	if !decodeJSON(w, r, &req) {
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

// CopyObjectRequest moves one object to another connection.
type CopyObjectRequest struct {
	Object       string `json:"object"`
	TargetConnID string `json:"target_conn_id"`
	TargetObject string `json:"target_object"`
}

// CopyObject hands a single object to another connection.
//
// Both ends are resolved through the manager, so nothing crosses the wire twice
// and no serialization format has to be invented — the two connectors agree on
// connector.KeyExport between them. Refused unless both sides implement
// KeyCopier: "copy this over there" means something for a Redis key and nothing
// for a Postgres table.
func (h *DataHandler) CopyObject(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")

	var req CopyObjectRequest
	if !decodeJSON(w, r, &req) {
		return
	}
	if strings.TrimSpace(req.Object) == "" {
		writeError(w, http.StatusBadRequest, "object is required")
		return
	}
	if strings.TrimSpace(req.TargetConnID) == "" {
		writeError(w, http.StatusBadRequest, "target_conn_id is required")
		return
	}
	target := strings.TrimSpace(req.TargetObject)
	if target == "" {
		target = req.Object
	}
	if req.TargetConnID == id && target == req.Object {
		writeError(w, http.StatusBadRequest, "the source and the destination are the same object")
		return
	}

	source, releaseSource, err := getConnector(r.Context(), h.manager, id)
	if err != nil {
		writeConnectorError(w, err)
		return
	}
	defer releaseSource()

	destination, releaseDestination, err := getConnector(r.Context(), h.manager, req.TargetConnID)
	if err != nil {
		writeConnectorError(w, err)
		return
	}
	defer releaseDestination()

	exporter, ok := source.(connector.KeyCopier)
	if !ok {
		writeError(w, http.StatusBadRequest, "this source cannot hand an object to another connection")
		return
	}
	importer, ok := destination.(connector.KeyCopier)
	if !ok {
		writeError(w, http.StatusBadRequest, "this destination cannot accept an object")
		return
	}

	export, err := exporter.ExportKey(r.Context(), req.Object, false)
	if err != nil {
		writeConnectorError(w, err)
		return
	}

	err = importer.ImportKey(r.Context(), target, export)
	// The destination refusing RESTORE is not a failure, it is the other half of
	// the same permission split the local duplicate already handles: ask the
	// source for the plain form and write it by hand.
	if err != nil && export.Dump != "" && errors.Is(err, connector.ErrForbidden) {
		plain, exportErr := exporter.ExportKey(r.Context(), req.Object, true)
		if exportErr != nil {
			writeConnectorError(w, exportErr)
			return
		}
		err = importer.ImportKey(r.Context(), target, plain)
	}
	if err != nil {
		writeConnectorError(w, err)
		return
	}

	writeJSON(w, http.StatusOK, map[string]any{"object": target, "type": export.Type})
}

// ExportObject renders one object as a JSON document for the clipboard.
//
// Deliberately a read: it is offered on read-only connections, where copying a
// key OUT is exactly what someone needs and changing it is exactly what they
// must not do.
func (h *DataHandler) ExportObject(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	// Unescaped like every other {name} route: chi hands back the raw path
	// segment, so a Redis key reaches here as "profile%3A123" and would be
	// looked up under that literal name.
	object, err := url.PathUnescape(chi.URLParam(r, "name"))
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid object name")
		return
	}
	if strings.TrimSpace(object) == "" {
		writeError(w, http.StatusBadRequest, "object is required")
		return
	}

	conn, cancel, err := getConnector(r.Context(), h.manager, id)
	if err != nil {
		writeConnectorError(w, err)
		return
	}
	defer cancel()

	exporter, ok := conn.(connector.KeyCopier)
	if !ok {
		writeError(w, http.StatusBadRequest, "this source cannot export an object")
		return
	}

	doc, err := exporter.ExportDocument(r.Context(), object)
	if err != nil {
		writeConnectorError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, doc)
}
