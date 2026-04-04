package handlers

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/qsnake66/infraview/internal/config"
	"github.com/qsnake66/infraview/internal/connector"
)

type testObjectsConnector struct {
	objects []connector.Object
	info    *connector.ObjectInfo
}

func (c *testObjectsConnector) Ping(context.Context) error { return nil }

func (c *testObjectsConnector) GetInfo(context.Context) (*connector.ConnInfo, error) { return nil, nil }

func (c *testObjectsConnector) ListObjects(context.Context, string) ([]connector.Object, error) {
	return c.objects, nil
}

func (c *testObjectsConnector) GetObjectInfo(context.Context, string) (*connector.ObjectInfo, error) {
	return c.info, nil
}

func (c *testObjectsConnector) GetSchema(context.Context, string) (*connector.Schema, error) {
	return nil, nil
}

func (c *testObjectsConnector) GetData(context.Context, string, connector.DataOpts) (*connector.DataResult, error) {
	return nil, nil
}

func (c *testObjectsConnector) Execute(context.Context, string) (*connector.ExecResult, error) {
	return nil, nil
}

func (c *testObjectsConnector) Mutate(context.Context, connector.MutateOp) (*connector.MutateResult, error) {
	return nil, nil
}

func (c *testObjectsConnector) MutateBulk(context.Context, connector.BulkMutateOp) (*connector.BulkMutateResult, error) {
	return nil, nil
}

func (c *testObjectsConnector) DDL(context.Context, connector.DDLOp) error { return nil }

func (c *testObjectsConnector) Close() error { return nil }

func newTestObjectsHandler(t *testing.T, conn connector.Connector) *ObjectsHandler {
	t.Helper()

	cfg := &config.AppConfig{
		Connections: []config.ConnectionConfig{
			{ID: "conn-1", Type: "postgres"},
		},
		EncryptionKey: "test-key",
	}
	manager := connector.NewConnectionManager(cfg)
	manager.RegisterFactory("postgres", func(context.Context, config.ConnectionConfig, string) (connector.Connector, error) {
		return conn, nil
	})

	return NewObjectsHandler(cfg, manager)
}

func withRouteParams(req *http.Request, params map[string]string) *http.Request {
	routeCtx := chi.NewRouteContext()
	for key, value := range params {
		routeCtx.URLParams.Add(key, value)
	}
	return req.WithContext(context.WithValue(req.Context(), chi.RouteCtxKey, routeCtx))
}

func TestObjectsHandlerListObjectsIncludesParentName(t *testing.T) {
	t.Parallel()

	handler := newTestObjectsHandler(t, &testObjectsConnector{
		objects: []connector.Object{
			{Name: "users", Type: "table", Schema: "public"},
			{Name: "idx_users_email", Type: "index", Schema: "public", ParentName: "users"},
		},
	})

	req := withRouteParams(httptest.NewRequest(http.MethodGet, "/api/connections/conn-1/objects?path=public", nil), map[string]string{
		"id": "conn-1",
	})
	rec := httptest.NewRecorder()

	handler.ListObjects(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("unexpected status: got %d", rec.Code)
	}

	var got []connector.Object
	if err := json.NewDecoder(rec.Body).Decode(&got); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if len(got) != 2 {
		t.Fatalf("unexpected objects length: got %d", len(got))
	}
	if got[1].ParentName != "users" {
		t.Fatalf("unexpected parent_name: got %q", got[1].ParentName)
	}
}

func TestObjectsHandlerGetObjectInfo(t *testing.T) {
	t.Parallel()

	predicate := "deleted_at IS NULL"
	handler := newTestObjectsHandler(t, &testObjectsConnector{
		info: &connector.ObjectInfo{
			Name:       "idx_users_email",
			Schema:     "public",
			ObjectType: "index",
			OwnerTable: "users",
			Columns:    []string{"email", "lower(name)"},
			Method:     "btree",
			IsUnique:   true,
			Predicate:  &predicate,
			Definition: `CREATE UNIQUE INDEX idx_users_email ON public.users USING btree (email) WHERE deleted_at IS NULL`,
		},
	})

	req := withRouteParams(httptest.NewRequest(http.MethodGet, "/api/connections/conn-1/objects/public.idx_users_email/info", nil), map[string]string{
		"id":   "conn-1",
		"name": "public.idx_users_email",
	})
	rec := httptest.NewRecorder()

	handler.GetObjectInfo(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("unexpected status: got %d", rec.Code)
	}

	var got connector.ObjectInfo
	if err := json.NewDecoder(rec.Body).Decode(&got); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if got.ObjectType != "index" {
		t.Fatalf("unexpected object type: got %q", got.ObjectType)
	}
	if got.OwnerTable != "users" {
		t.Fatalf("unexpected owner table: got %q", got.OwnerTable)
	}
	if len(got.Columns) != 2 || got.Columns[1] != "lower(name)" {
		t.Fatalf("unexpected columns: %#v", got.Columns)
	}
	if got.Predicate == nil || *got.Predicate != predicate {
		t.Fatalf("unexpected predicate: %#v", got.Predicate)
	}
}
