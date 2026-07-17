package handlers

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/zxchlorka/kizuna/internal/config"
	"github.com/zxchlorka/kizuna/internal/connector"
	"github.com/zxchlorka/kizuna/internal/history"
)

type SQLHandler struct {
	cfg     *config.AppConfig
	manager *connector.ConnectionManager
	history *history.Store
}

func NewSQLHandler(cfg *config.AppConfig, manager *connector.ConnectionManager) *SQLHandler {
	return &SQLHandler{
		cfg:     cfg,
		manager: manager,
		history: history.NewStore(cfg.GetPath()),
	}
}

type executeRequest struct {
	Statement string `json:"statement"`
}

type executeMultiRequest struct {
	Statements []string `json:"statements"`
}

type explainRequest struct {
	Query string `json:"query"`
}

func (h *SQLHandler) Execute(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")

	var req executeRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body: "+err.Error())
		return
	}
	if strings.TrimSpace(req.Statement) == "" {
		writeError(w, http.StatusBadRequest, "statement is required")
		return
	}

	conn, err := h.manager.Get(r.Context(), id)
	if err != nil {
		writeConnectorError(w, err)
		return
	}

	startedAt := time.Now()
	result, err := conn.Execute(r.Context(), req.Statement)
	if err != nil {
		h.appendHistory(id, connector.HistoryEntry{
			ID:         fmt.Sprintf("%d", startedAt.UnixNano()),
			Command:    req.Statement,
			DurationMs: time.Since(startedAt).Milliseconds(),
			Error:      err.Error(),
			ExecutedAt: startedAt.UTC().Format(time.RFC3339),
		})
		writeConnectorError(w, err)
		return
	}

	h.appendResult(id, req.Statement, result, startedAt)
	writeJSON(w, http.StatusOK, result)
}

func (h *SQLHandler) ExecuteMulti(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")

	var req executeMultiRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body: "+err.Error())
		return
	}
	if len(req.Statements) == 0 {
		writeError(w, http.StatusBadRequest, "statements are required")
		return
	}

	conn, err := h.manager.Get(r.Context(), id)
	if err != nil {
		writeConnectorError(w, err)
		return
	}

	results, err := conn.ExecuteBatch(r.Context(), req.Statements)
	if err != nil {
		writeConnectorError(w, err)
		return
	}

	for _, result := range results {
		if result.Skipped || strings.TrimSpace(result.Statement) == "" {
			continue
		}
		h.appendHistory(id, connector.HistoryEntry{
			ID:           fmt.Sprintf("%d", time.Now().UnixNano()),
			Command:      result.Statement,
			DurationMs:   result.DurationMs,
			RowsReturned: result.RowsReturned,
			RowsAffected: result.RowsAffected,
			Error:        result.Error,
			ExecutedAt:   time.Now().UTC().Format(time.RFC3339),
		})
	}

	writeJSON(w, http.StatusOK, map[string]any{"results": results})
}

func (h *SQLHandler) Explain(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")

	var req explainRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body: "+err.Error())
		return
	}
	if strings.TrimSpace(req.Query) == "" {
		writeError(w, http.StatusBadRequest, "query is required")
		return
	}

	conn, err := h.manager.Get(r.Context(), id)
	if err != nil {
		writeConnectorError(w, err)
		return
	}

	result, err := conn.Explain(r.Context(), req.Query)
	if err != nil {
		writeConnectorError(w, err)
		return
	}

	writeJSON(w, http.StatusOK, result)
}

func (h *SQLHandler) Analyze(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")

	var req explainRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body: "+err.Error())
		return
	}
	if strings.TrimSpace(req.Query) == "" {
		writeError(w, http.StatusBadRequest, "query is required")
		return
	}

	conn, err := h.manager.Get(r.Context(), id)
	if err != nil {
		writeConnectorError(w, err)
		return
	}

	result, err := conn.Analyze(r.Context(), req.Query)
	if err != nil {
		writeConnectorError(w, err)
		return
	}

	writeJSON(w, http.StatusOK, result)
}

func (h *SQLHandler) Completions(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")

	req := connector.CompletionRequest{
		Prefix:  r.URL.Query().Get("prefix"),
		Context: strings.ToLower(strings.TrimSpace(r.URL.Query().Get("context"))),
		Table:   r.URL.Query().Get("table"),
	}
	switch req.Context {
	case "table", "column", "function", "keyword", "command", "key", "":
	default:
		writeError(w, http.StatusBadRequest, "context must be one of table, column, function, keyword, command, key")
		return
	}

	conn, err := h.manager.Get(r.Context(), id)
	if err != nil {
		writeConnectorError(w, err)
		return
	}

	items, err := conn.Completions(r.Context(), req)
	if err != nil {
		writeConnectorError(w, err)
		return
	}

	writeJSON(w, http.StatusOK, items)
}

func (h *SQLHandler) SQLCatalog(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")

	conn, err := h.manager.Get(r.Context(), id)
	if err != nil {
		writeConnectorError(w, err)
		return
	}

	provider, ok := conn.(connector.SQLCatalogProvider)
	if !ok {
		writeError(w, http.StatusBadRequest, "sql catalog is not supported for this connection type")
		return
	}

	catalog, err := provider.SQLCatalog(r.Context())
	if err != nil {
		writeConnectorError(w, err)
		return
	}

	writeJSON(w, http.StatusOK, catalog)
}

func (h *SQLHandler) History(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	limit := 50
	if raw := r.URL.Query().Get("limit"); raw != "" {
		parsed, err := strconv.Atoi(raw)
		if err != nil || parsed <= 0 {
			writeError(w, http.StatusBadRequest, "limit must be a positive integer")
			return
		}
		limit = parsed
	}

	items, err := h.history.List(id, limit, r.URL.Query().Get("search"))
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}

	writeJSON(w, http.StatusOK, items)
}

func (h *SQLHandler) ClearHistory(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")

	if err := h.history.Clear(id); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}

	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (h *SQLHandler) appendResult(connectionID string, statement string, result *connector.ExecResult, startedAt time.Time) {
	if result == nil {
		return
	}

	h.appendHistory(connectionID, connector.HistoryEntry{
		ID:           fmt.Sprintf("%d", startedAt.UnixNano()),
		Command:      statement,
		DurationMs:   result.DurationMs,
		RowsReturned: result.RowsReturned,
		RowsAffected: result.RowsAffected,
		Error:        result.Error,
		ExecutedAt:   startedAt.UTC().Format(time.RFC3339),
	})
}

func (h *SQLHandler) appendHistory(connectionID string, entry connector.HistoryEntry) {
	_ = h.history.Append(connectionID, entry)
}
