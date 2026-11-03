package handlers

import (
	"errors"
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

// SessionID names the SQL console tab the run belongs to. With it, a
// transaction opened by one run stays on the same server session for the
// next (see connector.SessionExecutor); without it every run is independent.
type executeRequest struct {
	Statement string `json:"statement"`
	SessionID string `json:"session_id"`
}

type executeMultiRequest struct {
	Statements []string `json:"statements"`
	SessionID  string   `json:"session_id"`
}

type explainRequest struct {
	Query string `json:"query"`
}

func (h *SQLHandler) Execute(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")

	var req executeRequest
	if !decodeJSON(w, r, &req) {
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
	var result *connector.ExecResult
	var txState connector.TxState
	sessions, inSession := conn.(connector.SessionExecutor)
	if inSession && req.SessionID != "" {
		result, txState, err = sessions.ExecuteInSession(r.Context(), req.SessionID, req.Statement)
	} else {
		result, err = conn.Execute(r.Context(), req.Statement)
	}
	if err != nil {
		h.appendHistory(id, connector.HistoryEntry{
			ID:         fmt.Sprintf("%d", startedAt.UnixNano()),
			Command:    req.Statement,
			DurationMs: time.Since(startedAt).Milliseconds(),
			Error:      err.Error(),
			ExecutedAt: startedAt.UTC().Format(time.RFC3339),
			Canceled:   errors.Is(err, connector.ErrCanceled),
		})
		writeSessionError(w, err, txState)
		return
	}

	h.appendResult(id, req.Statement, result, startedAt)
	result.Transaction = txState
	writeJSON(w, http.StatusOK, result)
}

func (h *SQLHandler) ExecuteMulti(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")

	var req executeMultiRequest
	if !decodeJSON(w, r, &req) {
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

	var results []connector.ExecResult
	var txState connector.TxState
	if sessions, ok := conn.(connector.SessionExecutor); ok && req.SessionID != "" {
		results, txState, err = sessions.ExecuteBatchInSession(r.Context(), req.SessionID, req.Statements)
	} else {
		results, err = conn.ExecuteBatch(r.Context(), req.Statements)
	}
	if err != nil {
		writeSessionError(w, err, txState)
		return
	}

	// Recorded as one batch, not one entry at a time: a client that cancelled
	// this run reads history the moment its request aborts, and a half-written
	// batch reads exactly like a finished one.
	entries := make([]connector.HistoryEntry, 0, len(results))
	for _, result := range results {
		if result.Skipped || strings.TrimSpace(result.Statement) == "" {
			continue
		}
		entries = append(entries, connector.HistoryEntry{
			ID:           fmt.Sprintf("%d", time.Now().UnixNano()),
			Command:      result.Statement,
			DurationMs:   result.DurationMs,
			RowsReturned: result.RowsReturned,
			RowsAffected: result.RowsAffected,
			Error:        result.Error,
			ExecutedAt:   time.Now().UTC().Format(time.RFC3339),
			Canceled:     result.Canceled,
		})
	}
	h.appendHistoryBatch(id, entries)

	resp := map[string]any{"results": results}
	if txState != "" {
		resp["transaction"] = txState
	}
	writeJSON(w, http.StatusOK, resp)
}

// writeSessionError is writeConnectorError that also says where the console
// session stands: a failed statement inside a transaction leaves it failed,
// and the console has to show that rather than guess.
func writeSessionError(w http.ResponseWriter, err error, txState connector.TxState) {
	if txState == "" {
		writeConnectorError(w, err)
		return
	}
	status, msg := mapConnectorError(err)
	writeJSON(w, status, map[string]any{"error": msg, "code": status, "transaction": txState})
}

// SessionState reports the transaction state of a console tab's session, so
// a console reopened after a page reload shows a transaction it left open.
func (h *SQLHandler) SessionState(w http.ResponseWriter, r *http.Request) {
	conn, err := h.manager.Get(r.Context(), chi.URLParam(r, "id"))
	if err != nil {
		writeConnectorError(w, err)
		return
	}
	state := connector.TxIdle
	if sessions, ok := conn.(connector.SessionExecutor); ok {
		if state, err = sessions.SessionState(r.Context(), chi.URLParam(r, "session")); err != nil {
			writeConnectorError(w, err)
			return
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"transaction": state})
}

// EndSession rolls back what a console tab left open and frees its connection;
// the console calls it when the tab closes or moves to another connection.
func (h *SQLHandler) EndSession(w http.ResponseWriter, r *http.Request) {
	conn, err := h.manager.Get(r.Context(), chi.URLParam(r, "id"))
	if err != nil {
		writeConnectorError(w, err)
		return
	}
	if sessions, ok := conn.(connector.SessionExecutor); ok {
		if err := sessions.EndSession(r.Context(), chi.URLParam(r, "session")); err != nil {
			writeConnectorError(w, err)
			return
		}
	}
	w.WriteHeader(http.StatusNoContent)
}

func (h *SQLHandler) Explain(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")

	var req explainRequest
	if !decodeJSON(w, r, &req) {
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
	if !decodeJSON(w, r, &req) {
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

func (h *SQLHandler) appendHistoryBatch(connectionID string, entries []connector.HistoryEntry) {
	_ = h.history.AppendMany(connectionID, entries)
}
