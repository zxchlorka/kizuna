package server

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"testing/fstest"

	"github.com/go-chi/chi/v5"
)

// The static handler has to tell three things apart: a real asset, a
// client-side route that only looks like a path, and an API URL that no
// frontend fallback may swallow. Getting the last one wrong turns a 404 from
// the API into a 200 serving index.html, which the frontend then tries to
// parse as JSON.
func TestServeFrontendRouting(t *testing.T) {
	frontend := fstest.MapFS{
		"index.html":    &fstest.MapFile{Data: []byte("<!doctype html>app")},
		"assets/app.js": &fstest.MapFile{Data: []byte("console.log(1)")},
	}

	api := chi.NewRouter()
	api.Get("/api/health", func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"status":"ok"}`))
	})

	handler := New(api, frontend, "127.0.0.1:0").Handler

	tests := []struct {
		name       string
		path       string
		wantStatus int
		wantBody   string
	}{
		{name: "root serves the app shell", path: "/", wantStatus: http.StatusOK, wantBody: "<!doctype html>app"},
		{name: "real asset is served verbatim", path: "/assets/app.js", wantStatus: http.StatusOK, wantBody: "console.log(1)"},
		{name: "client-side route falls back to the shell", path: "/connections/abc", wantStatus: http.StatusOK, wantBody: "<!doctype html>app"},
		{name: "api route still reaches the API", path: "/api/health", wantStatus: http.StatusOK, wantBody: `{"status":"ok"}`},
		{name: "unknown api route 404s instead of serving the shell", path: "/api/nope", wantStatus: http.StatusNotFound, wantBody: `{"error":"not found"}`},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			rec := httptest.NewRecorder()
			handler.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, tt.path, nil))

			if rec.Code != tt.wantStatus {
				t.Fatalf("status = %d, want %d", rec.Code, tt.wantStatus)
			}
			if got := rec.Body.String(); got != tt.wantBody && got != tt.wantBody+"\n" {
				t.Fatalf("body = %q, want %q", got, tt.wantBody)
			}
		})
	}
}
