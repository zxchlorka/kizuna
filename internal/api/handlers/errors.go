package handlers

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net"
	"net/http"
	"strings"

	"github.com/jackc/pgx/v5/pgconn"
	"github.com/zxchlorka/kizuna/internal/connector"
)

// statusClientClosedRequest mirrors nginx's non-standard 499 "Client Closed
// Request": the client (SQL console Cancel/Stop) aborted the request, so this
// is neither a server error nor a real timeout. In practice the browser's
// fetch is already aborted by the time this would be written, so no client
// ever reads it -- it exists for callers that inspect the response directly
// (tests, logs) so a cancel doesn't get misread as a 500 or a 408.
const statusClientClosedRequest = 499

func writeJSON(w http.ResponseWriter, code int, data any) {
	// Marshal up front so an encoding failure surfaces as a 500 instead of a
	// silent empty 200 (headers already flushed).
	body, err := json.Marshal(data)
	if err != nil {
		slog.Error("failed to encode response", "error", err)
		writeError(w, http.StatusInternalServerError, "failed to encode response")
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_, _ = w.Write(body)
}

func writeError(w http.ResponseWriter, code int, msg string) {
	writeJSON(w, code, map[string]any{
		"error": msg,
		"code":  code,
	})
}

// decodeJSON parses the request body into dst. On failure it has already
// written the 400, so the caller only has to return.
//
// The decoder error is included: it describes the caller's own payload
// ("invalid character 'x' looking for beginning of value"), which is the one
// detail that makes a malformed request debuggable, and it leaks nothing about
// the server. Half the handlers used to drop it.
func decodeJSON(w http.ResponseWriter, r *http.Request, dst any) bool {
	if err := json.NewDecoder(r.Body).Decode(dst); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body: "+err.Error())
		return false
	}
	return true
}

func writeConnectorError(w http.ResponseWriter, err error) {
	status, msg := mapConnectorError(err)
	writeError(w, status, msg)
}

func mapConnectorError(err error) (int, string) {
	switch {
	case err == nil:
		return http.StatusOK, ""
	case errors.Is(err, connector.ErrBadRequest):
		return http.StatusBadRequest, err.Error()
	case errors.Is(err, connector.ErrForbidden):
		return http.StatusForbidden, err.Error()
	case errors.Is(err, connector.ErrReadOnly):
		return http.StatusForbidden, err.Error()
	case errors.Is(err, connector.ErrRelationNotFound):
		return http.StatusNotFound, err.Error()
	case errors.Is(err, connector.ErrConflict):
		return http.StatusConflict, err.Error()
	case errors.Is(err, connector.ErrCanceled), errors.Is(err, context.Canceled):
		return statusClientClosedRequest, err.Error()
	case errors.Is(err, connector.ErrTimeout), errors.Is(err, context.DeadlineExceeded):
		return http.StatusRequestTimeout, err.Error()
	case errors.Is(err, connector.ErrUnavailable):
		return http.StatusServiceUnavailable, withRetryHint(err.Error())
	}

	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) {
		switch pgErr.Code {
		case "23505":
			return http.StatusConflict, pgErr.Message
		case "42501":
			return http.StatusForbidden, pgErr.Message
		case "42P01", "42704":
			return http.StatusNotFound, pgErr.Message
		case "57014":
			// Same split as normalizePostgresError: a server-side statement_timeout
			// raises query_canceled too, and it is a timeout, not a cancel.
			if strings.Contains(strings.ToLower(pgErr.Message), "statement timeout") {
				return http.StatusRequestTimeout, pgErr.Message
			}
			return statusClientClosedRequest, pgErr.Message
		}
	}

	if isUnavailableError(err) {
		return http.StatusServiceUnavailable, withRetryHint(err.Error())
	}

	if strings.Contains(strings.ToLower(err.Error()), "not found") {
		return http.StatusNotFound, err.Error()
	}

	return http.StatusInternalServerError, err.Error()
}

func isUnavailableError(err error) bool {
	var opErr *net.OpError
	if errors.As(err, &opErr) {
		return true
	}

	msg := strings.ToLower(err.Error())
	switch {
	case strings.Contains(msg, "connection refused"),
		strings.Contains(msg, "dial tcp"),
		strings.Contains(msg, "connection reset"),
		strings.Contains(msg, "broken pipe"),
		strings.Contains(msg, "failed to connect"):
		return true
	default:
		return false
	}
}

func withRetryHint(msg string) string {
	if strings.Contains(strings.ToLower(msg), "retry") {
		return msg
	}
	return msg + ". Retry the request after checking the connection."
}
