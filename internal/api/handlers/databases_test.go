package handlers

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/zxchlorka/kizuna/internal/config"
)

func newDuplicateRequest(id, body string) *http.Request {
	req := httptest.NewRequest(http.MethodPost, "/api/connections/"+id+"/duplicate", strings.NewReader(body))
	rctx := chi.NewRouteContext()
	rctx.URLParams.Add("id", id)
	return req.WithContext(context.WithValue(req.Context(), chi.RouteCtxKey, rctx))
}

func TestConnectionsHandlerDuplicate(t *testing.T) {
	t.Parallel()

	baseConnections := func() []config.ConnectionConfig {
		return []config.ConnectionConfig{
			{
				ID:             "pg-1",
				Name:           "prod",
				Type:           "postgres",
				Host:           "db.example",
				Port:           5432,
				Database:       "tx_reconciler_db",
				Username:       "app",
				Password:       "encrypted-secret",
				Tags:           []string{"production"},
				VisibleSchemas: []string{"cch", "public"},
				ReadOnly:       true,
			},
			{
				ID:       "pg-2",
				Name:     "prod · other_db",
				Type:     "postgres",
				Host:     "db.example",
				Port:     5432,
				Database: "other_db",
				Username: "app",
			},
			{
				ID:   "redis-1",
				Type: "redis",
				Host: "redis.example",
				Port: 6379,
			},
		}
	}

	tests := []struct {
		name       string
		id         string
		body       string
		wantStatus int
		wantID     string
		wantName   string
	}{
		{
			name:       "creates sibling with copied credentials",
			id:         "pg-1",
			body:       `{"database":"tx_reconciler_ireland_db"}`,
			wantStatus: http.StatusCreated,
			wantName:   "prod · tx_reconciler_ireland_db",
		},
		{
			name:       "same database returns source",
			id:         "pg-1",
			body:       `{"database":"tx_reconciler_db"}`,
			wantStatus: http.StatusOK,
			wantID:     "pg-1",
		},
		{
			name:       "existing sibling is reused",
			id:         "pg-1",
			body:       `{"database":"other_db"}`,
			wantStatus: http.StatusOK,
			wantID:     "pg-2",
		},
		{
			name:       "empty database fails",
			id:         "pg-1",
			body:       `{"database":"  "}`,
			wantStatus: http.StatusBadRequest,
		},
		{
			name:       "non-postgres fails",
			id:         "redis-1",
			body:       `{"database":"whatever"}`,
			wantStatus: http.StatusBadRequest,
		},
		{
			name:       "unknown connection fails",
			id:         "missing",
			body:       `{"database":"db"}`,
			wantStatus: http.StatusNotFound,
		},
	}

	for _, tc := range tests {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			handler := newTestConnectionsHandler(t, baseConnections())
			rec := httptest.NewRecorder()

			handler.Duplicate(rec, newDuplicateRequest(tc.id, tc.body))

			if rec.Code != tc.wantStatus {
				t.Fatalf("unexpected status: got %d want %d (%s)", rec.Code, tc.wantStatus, rec.Body.String())
			}
			if tc.wantStatus >= http.StatusBadRequest {
				return
			}

			var resp connectionResponse
			if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
				t.Fatalf("decode response: %v", err)
			}
			if tc.wantID != "" && resp.ID != tc.wantID {
				t.Fatalf("unexpected id: got %q want %q", resp.ID, tc.wantID)
			}
			if tc.wantName != "" && resp.Name != tc.wantName {
				t.Fatalf("unexpected name: got %q want %q", resp.Name, tc.wantName)
			}

			if tc.wantStatus == http.StatusCreated {
				created, ok := handler.cfg.GetConnection(resp.ID)
				if !ok {
					t.Fatal("created sibling not persisted in config")
				}
				if created.Password != "encrypted-secret" {
					t.Fatalf("password not copied: got %q", created.Password)
				}
				if !created.ReadOnly {
					t.Fatal("read_only flag not copied")
				}
				if created.Database != "tx_reconciler_ireland_db" {
					t.Fatalf("unexpected database: %q", created.Database)
				}
			}
		})
	}
}
