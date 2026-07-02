package handlers

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/qsnake66/kizuna/internal/config"
	"github.com/qsnake66/kizuna/internal/connector"
)

type testSQLConnector struct {
	executeResults []*connector.ExecResult
	executeErrors  []error
	batchResults   []connector.ExecResult
	batchErr       error
	batchCalled    bool
	executeCalls   int
	explainResult  *connector.ExplainResult
	explainErr     error
	analyzeResult  *connector.ExplainResult
	analyzeErr     error
	completions    []connector.CompletionItem
}

func (c *testSQLConnector) Ping(context.Context) error { return nil }

func (c *testSQLConnector) GetInfo(context.Context) (*connector.ConnInfo, error) { return nil, nil }

func (c *testSQLConnector) ListObjects(context.Context, string) ([]connector.Object, error) {
	return nil, nil
}

func (c *testSQLConnector) GetObjectInfo(context.Context, string) (*connector.ObjectInfo, error) {
	return nil, nil
}

func (c *testSQLConnector) GetSchema(context.Context, string) (*connector.Schema, error) {
	return nil, nil
}

func (c *testSQLConnector) GetData(context.Context, string, connector.DataOpts) (*connector.DataResult, error) {
	return nil, nil
}

func (c *testSQLConnector) Execute(context.Context, string) (*connector.ExecResult, error) {
	c.executeCalls++
	if len(c.executeResults) > 0 {
		result := c.executeResults[0]
		c.executeResults = c.executeResults[1:]
		var err error
		if len(c.executeErrors) > 0 {
			err = c.executeErrors[0]
			c.executeErrors = c.executeErrors[1:]
		}
		if err != nil {
			return nil, err
		}
		return result, nil
	}
	if len(c.executeErrors) > 0 {
		err := c.executeErrors[0]
		c.executeErrors = c.executeErrors[1:]
		return nil, err
	}
	return &connector.ExecResult{}, nil
}

func (c *testSQLConnector) ExecuteBatch(context.Context, []string) ([]connector.ExecResult, error) {
	c.batchCalled = true
	if c.batchErr != nil {
		return nil, c.batchErr
	}
	if c.batchResults != nil {
		return c.batchResults, nil
	}
	return nil, nil
}

func (c *testSQLConnector) Explain(context.Context, string) (*connector.ExplainResult, error) {
	return c.explainResult, c.explainErr
}

func (c *testSQLConnector) Analyze(context.Context, string) (*connector.ExplainResult, error) {
	return c.analyzeResult, c.analyzeErr
}

func (c *testSQLConnector) Completions(context.Context, connector.CompletionRequest) ([]connector.CompletionItem, error) {
	return c.completions, nil
}

func (c *testSQLConnector) Mutate(context.Context, connector.MutateOp) (*connector.MutateResult, error) {
	return nil, nil
}

func (c *testSQLConnector) MutateBulk(context.Context, connector.BulkMutateOp) (*connector.BulkMutateResult, error) {
	return nil, nil
}

func (c *testSQLConnector) DDL(context.Context, connector.DDLOp) error { return nil }

func (c *testSQLConnector) Close() error { return nil }

func newTestSQLHandler(t *testing.T, conn connector.Connector) *SQLHandler {
	t.Helper()

	configPath := filepath.Join(t.TempDir(), "config.json")
	// Give the history store an isolated base directory per test run.
	cfg, err := config.Load(configPath)
	if err != nil {
		t.Fatalf("load config: %v", err)
	}
	cfg.Connections = []config.ConnectionConfig{{ID: "conn-1", Type: "postgres"}}
	cfg.EncryptionKey = "test-key"

	manager := connector.NewConnectionManager(cfg)
	manager.RegisterFactory("postgres", func(context.Context, config.ConnectionConfig, string) (connector.Connector, error) {
		return conn, nil
	})

	return NewSQLHandler(cfg, manager)
}

func withSQLRouteParams(req *http.Request, params map[string]string) *http.Request {
	routeCtx := chi.NewRouteContext()
	for key, value := range params {
		routeCtx.URLParams.Add(key, value)
	}
	return req.WithContext(context.WithValue(req.Context(), chi.RouteCtxKey, routeCtx))
}

func TestSQLHandlerExecuteRequiresStatement(t *testing.T) {
	t.Parallel()

	handler := newTestSQLHandler(t, &testSQLConnector{})
	req := withSQLRouteParams(httptest.NewRequest(http.MethodPost, "/api/connections/conn-1/execute", strings.NewReader(`{"statement":" "}`)), map[string]string{"id": "conn-1"})
	rec := httptest.NewRecorder()

	handler.Execute(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("unexpected status: got %d", rec.Code)
	}
}

func TestSQLHandlerExecuteMultiStopsAfterFailure(t *testing.T) {
	t.Parallel()

	conn := &testSQLConnector{
		batchResults: []connector.ExecResult{
			{Statement: "SELECT 1", DurationMs: 1, RowsReturned: 1},
			{Statement: "SELECT bad", Error: "bad request: broken statement", DurationMs: 2},
			{Statement: "SELECT 3", Skipped: true},
		},
	}
	handler := newTestSQLHandler(t, conn)

	req := withSQLRouteParams(
		httptest.NewRequest(http.MethodPost, "/api/connections/conn-1/execute-multi", strings.NewReader(`{"statements":["SELECT 1","SELECT bad","SELECT 3"]}`)),
		map[string]string{"id": "conn-1"},
	)
	rec := httptest.NewRecorder()

	handler.ExecuteMulti(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("unexpected status: got %d", rec.Code)
	}

	var payload struct {
		Results []connector.ExecResult `json:"results"`
	}
	if err := json.NewDecoder(rec.Body).Decode(&payload); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if len(payload.Results) != 3 {
		t.Fatalf("unexpected results length: %d", len(payload.Results))
	}
	if payload.Results[1].Error == "" {
		t.Fatalf("expected second statement error")
	}
	if !payload.Results[2].Skipped {
		t.Fatalf("expected third statement to be skipped")
	}
	if !conn.batchCalled {
		t.Fatalf("expected ExecuteBatch to be used")
	}
	if conn.executeCalls != 0 {
		t.Fatalf("expected Execute to not be used, got %d calls", conn.executeCalls)
	}
}

func TestSQLHandlerCompletionsRejectsInvalidContext(t *testing.T) {
	t.Parallel()

	handler := newTestSQLHandler(t, &testSQLConnector{})
	req := withSQLRouteParams(
		httptest.NewRequest(http.MethodGet, "/api/connections/conn-1/completions?context=nope", nil),
		map[string]string{"id": "conn-1"},
	)
	rec := httptest.NewRecorder()

	handler.Completions(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("unexpected status: got %d", rec.Code)
	}
}

func TestSQLHandlerCompletionsAcceptsRedisContexts(t *testing.T) {
	t.Parallel()

	handler := newTestSQLHandler(t, &testSQLConnector{
		completions: []connector.CompletionItem{{Label: "HGETALL", Type: "command"}},
	})
	req := withSQLRouteParams(
		httptest.NewRequest(http.MethodGet, "/api/connections/conn-1/completions?context=command&prefix=HG", nil),
		map[string]string{"id": "conn-1"},
	)
	rec := httptest.NewRecorder()

	handler.Completions(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("unexpected status: got %d", rec.Code)
	}
}

func TestSQLHandlerAnalyzeRequiresQuery(t *testing.T) {
	t.Parallel()

	handler := newTestSQLHandler(t, &testSQLConnector{})
	req := withSQLRouteParams(httptest.NewRequest(http.MethodPost, "/api/connections/conn-1/analyze", strings.NewReader(`{"query":" "}`)), map[string]string{"id": "conn-1"})
	rec := httptest.NewRecorder()

	handler.Analyze(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("unexpected status: got %d", rec.Code)
	}
}

func TestSQLHandlerAnalyzeReturnsResult(t *testing.T) {
	t.Parallel()

	handler := newTestSQLHandler(t, &testSQLConnector{
		analyzeResult: &connector.ExplainResult{
			Mode:       "analyze",
			DurationMs: 12,
		},
	})
	req := withSQLRouteParams(httptest.NewRequest(http.MethodPost, "/api/connections/conn-1/analyze", strings.NewReader(`{"query":"SELECT 1"}`)), map[string]string{"id": "conn-1"})
	rec := httptest.NewRecorder()

	handler.Analyze(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("unexpected status: got %d", rec.Code)
	}

	var payload connector.ExplainResult
	if err := json.NewDecoder(rec.Body).Decode(&payload); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if payload.Mode != "analyze" {
		t.Fatalf("unexpected mode: %q", payload.Mode)
	}
}
