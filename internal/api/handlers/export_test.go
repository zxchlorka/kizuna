package handlers

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/zxchlorka/kizuna/internal/config"
	"github.com/zxchlorka/kizuna/internal/connector"
)

// testCopierConnector records the key name it was asked for, which is the whole
// point of the test below.
type testCopierConnector struct {
	testObjectsConnector
	askedFor string
}

func (c *testCopierConnector) ExportKey(context.Context, string, bool) (*connector.KeyExport, error) {
	return nil, nil
}

func (c *testCopierConnector) ImportKey(context.Context, string, *connector.KeyExport) error {
	return nil
}

func (c *testCopierConnector) ExportDocument(_ context.Context, key string) (map[string]any, error) {
	c.askedFor = key
	return map[string]any{"key": key, "type": "hash"}, nil
}

// A Redis key is full of colons, and the browser percent-encodes them into the
// path. chi hands back the raw segment, so without unescaping the connector is
// asked for a key literally named "profile%3A123" and answers "not found" —
// which is what shipped, because the curl checks used a bare colon and never
// exercised the encoding a browser always applies.
func TestExportObjectUnescapesTheKeyName(t *testing.T) {
	t.Parallel()

	conn := &testCopierConnector{}
	cfg := &config.AppConfig{
		Connections:   []config.ConnectionConfig{{ID: "conn-1", Type: "redis"}},
		EncryptionKey: "test-key",
	}
	manager := connector.NewConnectionManager(cfg)
	manager.RegisterFactory("redis", func(context.Context, config.ConnectionConfig, string) (connector.Connector, error) {
		return conn, nil
	})
	handler := NewDataHandler(cfg, manager)

	req := withRouteParams(
		httptest.NewRequest(http.MethodGet, "/api/connections/conn-1/objects/profile%3A2001946450336686086/export", nil),
		map[string]string{"id": "conn-1", "name": "profile%3A2001946450336686086"},
	)
	rec := httptest.NewRecorder()

	handler.ExportObject(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status %d, body %s", rec.Code, rec.Body.String())
	}
	if conn.askedFor != "profile:2001946450336686086" {
		t.Fatalf("connector was asked for %q, want the decoded key", conn.askedFor)
	}

	var doc map[string]any
	if err := json.NewDecoder(rec.Body).Decode(&doc); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if doc["key"] != "profile:2001946450336686086" {
		t.Fatalf("document names the key %q", doc["key"])
	}
}
