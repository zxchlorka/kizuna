package handlers

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"github.com/zxchlorka/kizuna/internal/config"
	"github.com/zxchlorka/kizuna/internal/connector"
)

const testProto = `syntax = "proto3";
package demo.v1;
message Item { int64 id = 1; }
message Event {
  int64 user_id = 1;
  repeated Item items = 2;
}
`

// testDataConnector records the options GetData was called with.
type testDataConnector struct {
	testFieldExporter
	opts connector.DataOpts
}

func (c *testDataConnector) GetData(_ context.Context, _ string, opts connector.DataOpts) (*connector.DataResult, error) {
	c.opts = opts
	return &connector.DataResult{}, nil
}

func newTopicProtoHandler(t *testing.T, conn connector.Connector) (*DataHandler, *config.AppConfig) {
	t.Helper()
	cfg, err := config.Load(filepath.Join(t.TempDir(), "config.json"))
	if err != nil {
		t.Fatal(err)
	}
	cfg.EncryptionKey = "test-key"
	cfg.AddConnection(config.ConnectionConfig{ID: "conn-1", Type: "kafka"})
	cfg.AddConnection(config.ConnectionConfig{ID: "pg-1", Type: "postgres"})
	manager := connector.NewConnectionManager(cfg)
	manager.RegisterFactory("kafka", func(context.Context, config.ConnectionConfig, string) (connector.Connector, error) {
		return conn, nil
	})
	return NewDataHandler(cfg, manager), cfg
}

func protoRequest(method, connID, topic, body string) *http.Request {
	r := httptest.NewRequest(method, "/api/connections/"+connID+"/objects/"+topic+"/proto", strings.NewReader(body))
	return withRouteParams(r, map[string]string{"id": connID, "name": topic})
}

func serve(handler http.HandlerFunc, r *http.Request) *httptest.ResponseRecorder {
	rec := httptest.NewRecorder()
	handler(rec, r)
	return rec
}

func TestTopicProtoLifecycle(t *testing.T) {
	h, cfg := newTopicProtoHandler(t, &testDataConnector{})
	body := func(v any) string {
		out, _ := json.Marshal(v)
		return string(out)
	}

	// Nothing attached yet.
	if rec := serve(h.GetTopicProto, protoRequest(http.MethodGet, "conn-1", "team%2Fevents", "")); rec.Code != http.StatusOK || strings.TrimSpace(rec.Body.String()) != "null" {
		t.Fatalf("GET before attach: %d %s", rec.Code, rec.Body.String())
	}

	// Attaching without naming a message picks the one nothing else refers to.
	rec := serve(h.PutTopicProto, protoRequest(http.MethodPut, "conn-1", "team%2Fevents", body(map[string]string{"file_name": "dir/event.proto", "source": testProto})))
	if rec.Code != http.StatusOK {
		t.Fatalf("PUT: %d %s", rec.Code, rec.Body.String())
	}
	want := `{"file_name":"event.proto","message":"demo.v1.Event","messages":["demo.v1.Item","demo.v1.Event"]}`
	if got := strings.TrimSpace(rec.Body.String()); got != want {
		t.Fatalf("PUT body %s, want %s", got, want)
	}
	stored, ok := cfg.GetTopicProto("conn-1", "team/events")
	if !ok || stored.Source != testProto {
		t.Fatalf("stored = %+v, %v; want it under the unescaped topic name", stored, ok)
	}

	// Switching the message keeps the file.
	rec = serve(h.PutTopicProto, protoRequest(http.MethodPut, "conn-1", "team%2Fevents", body(map[string]string{"message": "demo.v1.Item"})))
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"message":"demo.v1.Item"`) {
		t.Fatalf("PUT message only: %d %s", rec.Code, rec.Body.String())
	}
	if rec := serve(h.GetTopicProto, protoRequest(http.MethodGet, "conn-1", "team%2Fevents", "")); !strings.Contains(rec.Body.String(), `"message":"demo.v1.Item"`) {
		t.Fatalf("GET after switch: %s", rec.Body.String())
	}

	if rec := serve(h.DeleteTopicProto, protoRequest(http.MethodDelete, "conn-1", "team%2Fevents", "")); rec.Code != http.StatusNoContent {
		t.Fatalf("DELETE: %d", rec.Code)
	}
	if _, ok := cfg.GetTopicProto("conn-1", "team/events"); ok {
		t.Fatal("contract still attached after DELETE")
	}
}

func TestPutTopicProtoRejects(t *testing.T) {
	h, _ := newTopicProtoHandler(t, &testDataConnector{})
	tests := []struct {
		name   string
		connID string
		body   string
		status int
		want   string
	}{
		{name: "syntax error names the line", connID: "conn-1", body: `{"file_name":"bad.proto","source":"syntax = \"proto3\";\nmessage A {\n  int64 = 1;\n}\n"}`, status: http.StatusBadRequest, want: "bad.proto:3"},
		{name: "message the file lacks", connID: "conn-1", body: `{"file_name":"e.proto","source":` + jsonString(testProto) + `,"message":"demo.v1.Nope"}`, status: http.StatusBadRequest, want: "demo.v1.Nope"},
		{name: "message only, nothing attached", connID: "conn-1", body: `{"message":"demo.v1.Event"}`, status: http.StatusBadRequest, want: "source"},
		{name: "not a Kafka connection", connID: "pg-1", body: `{"source":` + jsonString(testProto) + `}`, status: http.StatusBadRequest, want: "Kafka"},
		{name: "unknown connection", connID: "nope", body: `{"source":` + jsonString(testProto) + `}`, status: http.StatusNotFound, want: "not found"},
		{name: "too large", connID: "conn-1", body: `{"source":` + jsonString(strings.Repeat("/", maxProtoSourceBytes+1)) + `}`, status: http.StatusBadRequest, want: "too large"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			rec := serve(h.PutTopicProto, protoRequest(http.MethodPut, tt.connID, "events", tt.body))
			if rec.Code != tt.status || !strings.Contains(rec.Body.String(), tt.want) {
				t.Fatalf("got %d %s, want %d mentioning %q", rec.Code, rec.Body.String(), tt.status, tt.want)
			}
		})
	}
}

func jsonString(s string) string {
	out, _ := json.Marshal(s)
	return string(out)
}

func TestGetDataPassesTheTopicDecoder(t *testing.T) {
	conn := &testDataConnector{}
	h, cfg := newTopicProtoHandler(t, conn)
	cfg.SetTopicProto(config.TopicProtoConfig{ConnID: "conn-1", Topic: "events", FileName: "e.proto", Source: testProto, Message: "demo.v1.Event"})

	get := func(topic string) {
		r := withRouteParams(httptest.NewRequest(http.MethodGet, "/api/connections/conn-1/objects/"+topic+"/data", nil), map[string]string{"id": "conn-1", "name": topic})
		if rec := serve(h.GetData, r); rec.Code != http.StatusOK {
			t.Fatalf("GetData %s: %d %s", topic, rec.Code, rec.Body.String())
		}
	}

	get("events")
	if conn.opts.ValueDecoder == nil {
		t.Fatal("no decoder passed for a topic with a contract")
	}
	// user_id 5, one item with id 6.
	if got, ok := conn.opts.ValueDecoder.Decode([]byte{0x08, 0x05, 0x12, 0x02, 0x08, 0x06}); !ok || got != `{"user_id":5,"items":[{"id":6}]}` {
		t.Fatalf("decoded %q, %v", got, ok)
	}

	get("other")
	if conn.opts.ValueDecoder != nil {
		t.Fatal("decoder passed for a topic without a contract")
	}
}

func TestExportFieldsPassesTheTopicDecoder(t *testing.T) {
	conn := &testDataConnector{}
	h, cfg := newTopicProtoHandler(t, conn)
	cfg.SetTopicProto(config.TopicProtoConfig{ConnID: "conn-1", Topic: "events", FileName: "e.proto", Source: testProto, Message: "demo.v1.Event"})

	rec := httptest.NewRecorder()
	h.ExportFields(rec, fieldExportRequest("events", "fields="+`%5B%22user_id%22%5D`))
	if conn.decoder == nil {
		t.Fatalf("no decoder passed to the export (status %d %s)", rec.Code, rec.Body.String())
	}
}
