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
			return http.StatusRequestTimeout, pgErr.Message
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
