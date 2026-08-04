package server

import (
	"io/fs"
	"log/slog"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
)

func New(apiRouter chi.Router, frontendFS fs.FS, addr string) *http.Server {
	mux := chi.NewRouter()

	mux.Use(securityHeaders)

	// Mount API routes
	mux.Mount("/", apiRouter)

	// Serve frontend static files with SPA fallback
	if frontendFS != nil {
		fileServer := http.FileServerFS(frontendFS)
		mux.NotFound(func(w http.ResponseWriter, r *http.Request) {
			// Don't serve index.html for API routes
			if strings.HasPrefix(r.URL.Path, "/api/") {
				http.Error(w, `{"error":"not found"}`, http.StatusNotFound)
				return
			}

			// Anything that is not a real file is a client-side route (and "/"
			// is never a file), so hand back index.html and let the router in
			// the page resolve it.
			if _, err := fs.Stat(frontendFS, strings.TrimPrefix(r.URL.Path, "/")); err != nil {
				http.ServeFileFS(w, r, frontendFS, "index.html")
				return
			}

			fileServer.ServeHTTP(w, r)
		})
	} else {
		slog.Warn("no frontend files embedded, serving API only")
	}

	return &http.Server{
		Addr:    addr,
		Handler: mux,
	}
}

// contentSecurityPolicy keeps the page from reaching outside the binary. Kizuna
// renders values it did not author — rows, Redis payloads, Kafka messages — so if
// markup ever escapes React's escaping, this is what stops it from loading remote
// code or exfiltrating what it read. 'unsafe-inline' for styles is required by
// CodeMirror, which injects its themes as inline <style> at runtime.
// Every source is 'self': fonts are vendored, so a correct page has no reason to
// touch another host and anything that tries is a bug or an attack.
const contentSecurityPolicy = "default-src 'self'; " +
	"script-src 'self'; " +
	"style-src 'self' 'unsafe-inline'; " +
	"img-src 'self' data: blob:; " +
	"font-src 'self' data:; " +
	"connect-src 'self'; " +
	"object-src 'none'; " +
	"base-uri 'none'; " +
	"form-action 'none'; " +
	"frame-ancestors 'none'"

func securityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("Content-Security-Policy", contentSecurityPolicy)
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("Referrer-Policy", "no-referrer")
		next.ServeHTTP(w, r)
	})
}
