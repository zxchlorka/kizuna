package middleware

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestOriginGuard(t *testing.T) {
	tests := []struct {
		name         string
		method       string
		path         string
		host         string
		origin       string
		clientHeader string
		allowedHosts []string
		wantStatus   int
	}{
		{
			name:       "read from the served page",
			method:     http.MethodGet,
			path:       "/api/connections",
			host:       "localhost:9090",
			wantStatus: http.StatusOK,
		},
		{
			name:         "write from the served page",
			method:       http.MethodPost,
			path:         "/api/connections",
			host:         "localhost:9090",
			origin:       "http://localhost:9090",
			clientHeader: "1",
			wantStatus:   http.StatusOK,
		},
		{
			name:         "write from the Vite dev server through the proxy",
			method:       http.MethodPost,
			path:         "/api/connections/1/execute",
			host:         "localhost:9090",
			origin:       "http://localhost:5173",
			clientHeader: "1",
			wantStatus:   http.StatusOK,
		},
		{
			// The attack the guard exists for: a page the user did not open
			// posting a DDL. Content-Type alone would not stop it, since no
			// handler checks it.
			name:         "write from a foreign page is rejected",
			method:       http.MethodPost,
			path:         "/api/connections/1/ddl",
			host:         "localhost:9090",
			origin:       "https://evil.example",
			clientHeader: "1",
			wantStatus:   http.StatusForbidden,
		},
		{
			name:       "write without the client header is rejected",
			method:     http.MethodPost,
			path:       "/api/connections/1/mutate",
			host:       "localhost:9090",
			wantStatus: http.StatusForbidden,
		},
		{
			name:       "delete without the client header is rejected",
			method:     http.MethodDelete,
			path:       "/api/links/3",
			host:       "localhost:9090",
			wantStatus: http.StatusForbidden,
		},
		{
			// DNS rebinding: the browser thinks this is same-origin, so neither
			// CORS nor the header check applies. Only the Host tells the truth.
			name:         "rebound domain is rejected even when same-origin",
			method:       http.MethodPost,
			path:         "/api/connections/1/execute",
			host:         "attacker.example:9090",
			origin:       "http://attacker.example:9090",
			clientHeader: "1",
			wantStatus:   http.StatusForbidden,
		},
		{
			name:       "rebound domain is rejected on reads too",
			method:     http.MethodGet,
			path:       "/api/connections",
			host:       "attacker.example:9090",
			wantStatus: http.StatusForbidden,
		},
		{
			name:         "bare LAN IP still works for a deliberate network bind",
			method:       http.MethodPost,
			path:         "/api/connections/1/execute",
			host:         "192.168.1.6:9090",
			origin:       "http://192.168.1.6:9090",
			clientHeader: "1",
			wantStatus:   http.StatusOK,
		},
		{
			name:         "IPv6 loopback literal",
			method:       http.MethodPost,
			path:         "/api/connections",
			host:         "[::1]:9090",
			origin:       "http://[::1]:9090",
			clientHeader: "1",
			wantStatus:   http.StatusOK,
		},
		{
			name:         "proxy hostname works once allowed",
			method:       http.MethodPost,
			path:         "/api/connections",
			host:         "kizuna.internal",
			origin:       "http://kizuna.internal",
			clientHeader: "1",
			allowedHosts: []string{"kizuna.internal"},
			wantStatus:   http.StatusOK,
		},
		{
			name:         "allowlist is matched case-insensitively",
			method:       http.MethodPost,
			path:         "/api/connections",
			host:         "Kizuna.Internal:9090",
			origin:       "http://Kizuna.Internal:9090",
			clientHeader: "1",
			allowedHosts: []string{" KIZUNA.INTERNAL "},
			wantStatus:   http.StatusOK,
		},
		{
			// Docker's healthcheck is not a browser and cannot be coerced into
			// carrying an attack, so it must not need the header.
			name:       "health stays reachable without headers",
			method:     http.MethodGet,
			path:       "/api/health",
			host:       "kizuna:9090",
			wantStatus: http.StatusOK,
		},
		{
			name:       "static assets are not guarded",
			method:     http.MethodGet,
			path:       "/assets/index.js",
			host:       "attacker.example",
			wantStatus: http.StatusOK,
		},
		{
			// curl and scripts send no Origin; they are not driven by a foreign
			// page, so the header alone gates them.
			name:         "scripted write with the header and no Origin",
			method:       http.MethodPost,
			path:         "/api/connections",
			host:         "127.0.0.1:9090",
			clientHeader: "1",
			wantStatus:   http.StatusOK,
		},
		{
			name:       "empty Host is rejected",
			method:     http.MethodGet,
			path:       "/api/connections",
			host:       "",
			wantStatus: http.StatusForbidden,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			handler := OriginGuard(tt.allowedHosts)(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				w.WriteHeader(http.StatusOK)
			}))

			req := httptest.NewRequest(tt.method, "http://example.invalid"+tt.path, nil)
			req.Host = tt.host
			if tt.origin != "" {
				req.Header.Set("Origin", tt.origin)
			}
			if tt.clientHeader != "" {
				req.Header.Set(ClientHeader, tt.clientHeader)
			}

			rec := httptest.NewRecorder()
			handler.ServeHTTP(rec, req)

			if rec.Code != tt.wantStatus {
				t.Errorf("status = %d, want %d", rec.Code, tt.wantStatus)
			}
		})
	}
}

func TestOriginGuardRejectionIsJSON(t *testing.T) {
	handler := OriginGuard(nil)(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		t.Error("handler should not have been reached")
	}))

	req := httptest.NewRequest(http.MethodPost, "http://example.invalid/api/connections", nil)
	req.Host = "localhost:9090"
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if got := rec.Header().Get("Content-Type"); got != "application/json" {
		t.Errorf("Content-Type = %q, want application/json", got)
	}

	// The frontend reads {"error":...,"code":...} from every other handler; a
	// rejection here must not be the one shape it cannot parse.
	var payload struct {
		Error string `json:"error"`
		Code  int    `json:"code"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &payload); err != nil {
		t.Fatalf("body is not valid JSON: %v (%s)", err, rec.Body.String())
	}
	if payload.Code != http.StatusForbidden {
		t.Errorf("code = %d, want 403", payload.Code)
	}
	if payload.Error == "" {
		t.Error("error message is empty")
	}
}
