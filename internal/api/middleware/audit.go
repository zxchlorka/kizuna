package middleware

import (
	"bytes"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
)

func Audit(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !isAuditedPath(r.URL.Path, r.Method) {
			next.ServeHTTP(w, r)
			return
		}

		body, err := io.ReadAll(r.Body)
		if err != nil {
			http.Error(w, `{"error":"failed to read request body"}`, http.StatusBadRequest)
			return
		}
		r.Body = io.NopCloser(bytes.NewReader(body))

		rec := &statusRecorder{ResponseWriter: w, status: http.StatusOK}
		next.ServeHTTP(rec, r)

		opType, object := extractAuditFields(body, r.URL.Path)
		slog.Info("audit event",
			"connection_id", chi.URLParam(r, "id"),
			"operation_type", opType,
			"object", object,
			"status", rec.status,
			"user_query", string(body),
		)
	})
}

func isAuditedPath(path string, method string) bool {
	if method != http.MethodPost {
		return false
	}
	return strings.HasSuffix(path, "/mutate") || strings.HasSuffix(path, "/mutate/bulk") || strings.HasSuffix(path, "/ddl")
}

func extractAuditFields(body []byte, path string) (string, string) {
	var payload map[string]any
	if err := json.Unmarshal(body, &payload); err != nil {
		return "unknown", ""
	}

	opType, _ := payload["type"].(string)
	schema, _ := payload["schema"].(string)
	object, _ := payload["object"].(string)
	if strings.HasSuffix(path, "/mutate/bulk") {
		opType = "mutate_bulk"
	}
	if opType == "" {
		opType = "unknown"
	}
	if schema != "" && object != "" {
		object = schema + "." + object
	}
	return opType, object
}
