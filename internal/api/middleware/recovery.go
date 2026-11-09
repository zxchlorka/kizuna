package middleware

import (
	"encoding/json"
	"log/slog"
	"net/http"
)

func Recovery(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer func() {
			if rec := recover(); rec != nil {
				// A deliberate abort of a response that is already streaming: net/http
				// drops the connection so the client sees the transfer fail. An error
				// body here would be appended to what was sent and end it cleanly.
				if rec == http.ErrAbortHandler {
					panic(rec)
				}
				slog.Error("panic recovered", "path", r.URL.Path, "method", r.Method, "panic", rec)
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(http.StatusInternalServerError)
				_ = json.NewEncoder(w).Encode(map[string]any{
					"error": "internal server error",
					"code":  http.StatusInternalServerError,
				})
			}
		}()

		next.ServeHTTP(w, r)
	})
}
