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
