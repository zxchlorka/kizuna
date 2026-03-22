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

	// Mount API routes
	mux.Mount("/", apiRouter)

	// Serve frontend static files with SPA fallback
	if frontendFS != nil {
		fileServer := http.FileServer(http.FS(frontendFS))
		mux.NotFound(func(w http.ResponseWriter, r *http.Request) {
			// Don't serve index.html for API routes
			if strings.HasPrefix(r.URL.Path, "/api/") {
				http.Error(w, `{"error":"not found"}`, http.StatusNotFound)
				return
			}

			// Try to serve the static file
			path := strings.TrimPrefix(r.URL.Path, "/")
			if path == "" {
				path = "index.html"
			}

			// Check if file exists
			f, err := frontendFS.Open(path)
			if err == nil {
				f.Close()
				fileServer.ServeHTTP(w, r)
				return
			}

			// SPA fallback: serve index.html for non-file routes
			r.URL.Path = "/"
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
