package handlers

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"github.com/qsnake66/infraview/internal/config"
	"github.com/qsnake66/infraview/internal/connector"
)

func newTestConnectionsHandler(t *testing.T, connections []config.ConnectionConfig) *ConnectionsHandler {
	t.Helper()

	path := filepath.Join(t.TempDir(), "config.json")
	cfg, err := config.Load(path)
	if err != nil {
		t.Fatalf("load config: %v", err)
	}
	cfg.Connections = connections
	cfg.EncryptionKey = "test-key"
	if err := cfg.Save(path); err != nil {
		t.Fatalf("save config: %v", err)
	}

	return NewConnectionsHandler(cfg, connector.NewConnectionManager(cfg))
}

func TestConnectionsHandlerListIncludesVisibleSchemas(t *testing.T) {
	t.Parallel()

	handler := newTestConnectionsHandler(t, []config.ConnectionConfig{
		{
			ID:             "conn-1",
			Name:           "Main",
			Type:           "postgres",
			Host:           "localhost",
			Port:           5432,
			Database:       "app",
			Username:       "postgres",
			VisibleSchemas: []string{"analytics", "public"},
		},
	})

	req := httptest.NewRequest(http.MethodGet, "/api/connections", nil)
	rec := httptest.NewRecorder()

	handler.List(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("unexpected status: got %d", rec.Code)
	}

	var got []struct {
		ID             string   `json:"id"`
		VisibleSchemas []string `json:"visible_schemas"`
	}
	if err := json.NewDecoder(rec.Body).Decode(&got); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if len(got) != 1 {
		t.Fatalf("unexpected connections length: got %d", len(got))
	}
	if !slices.Equal(got[0].VisibleSchemas, []string{"analytics", "public"}) {
		t.Fatalf("unexpected visible_schemas: %#v", got[0].VisibleSchemas)
	}
}

func TestConnectionsHandlerUpdateVisibleSchemas(t *testing.T) {
	t.Parallel()

	handler := newTestConnectionsHandler(t, []config.ConnectionConfig{
		{
			ID:             "conn-1",
			Name:           "Main",
			Type:           "postgres",
			Host:           "localhost",
			Port:           5432,
			Database:       "app",
			Username:       "postgres",
			VisibleSchemas: []string{"public"},
		},
	})

	t.Run("sets normalized schema list", func(t *testing.T) {
		req := withRouteParams(httptest.NewRequest(
			http.MethodPut,
			"/api/connections/conn-1/visible-schemas",
			strings.NewReader(`{"visible_schemas":[" reporting ","public","reporting"]}`),
		), map[string]string{"id": "conn-1"})

		rec := httptest.NewRecorder()
		handler.UpdateVisibleSchemas(rec, req)

		if rec.Code != http.StatusOK {
			t.Fatalf("unexpected status: got %d", rec.Code)
		}

		updated, ok := handler.cfg.GetConnection("conn-1")
		if !ok {
			t.Fatal("expected updated connection")
		}
		if !slices.Equal(updated.VisibleSchemas, []string{"public", "reporting"}) {
			t.Fatalf("unexpected visible_schemas: %#v", updated.VisibleSchemas)
		}
	})

	t.Run("resets to nil when request is null", func(t *testing.T) {
		req := withRouteParams(httptest.NewRequest(
			http.MethodPut,
			"/api/connections/conn-1/visible-schemas",
			strings.NewReader(`{"visible_schemas":null}`),
		), map[string]string{"id": "conn-1"})

		rec := httptest.NewRecorder()
		handler.UpdateVisibleSchemas(rec, req)

		if rec.Code != http.StatusOK {
			t.Fatalf("unexpected status: got %d", rec.Code)
		}

		updated, ok := handler.cfg.GetConnection("conn-1")
		if !ok {
			t.Fatal("expected updated connection")
		}
		if updated.VisibleSchemas != nil {
			t.Fatalf("expected nil visible_schemas, got %#v", updated.VisibleSchemas)
		}
	})
}
