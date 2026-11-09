package handlers

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"regexp"
	"strings"
	"testing"

	"github.com/zxchlorka/kizuna/internal/api/middleware"
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

// testFieldExporter emits rows, then optionally fails; failBefore fails before
// the first row, the way a bad filter or a missing topic does.
type testFieldExporter struct {
	testObjectsConnector
	rows       [][]string
	failBefore error
	failAfter  error
	topic      string
	fields     []string
	filters    []connector.FilterExpr
}

func (c *testFieldExporter) ExportFields(_ context.Context, topic string, fields []string, filters []connector.FilterExpr, emit func([]string) error) error {
	c.topic, c.fields, c.filters = topic, fields, filters
	if c.failBefore != nil {
		return c.failBefore
	}
	for _, row := range c.rows {
		if err := emit(row); err != nil {
			return err
		}
	}
	return c.failAfter
}

func newFieldExportHandler(conn connector.Connector) *DataHandler {
	cfg := &config.AppConfig{
		Connections:   []config.ConnectionConfig{{ID: "conn-1", Type: "kafka"}},
		EncryptionKey: "test-key",
	}
	manager := connector.NewConnectionManager(cfg)
	manager.RegisterFactory("kafka", func(context.Context, config.ConnectionConfig, string) (connector.Connector, error) {
		return conn, nil
	})
	return NewDataHandler(cfg, manager)
}

func fieldExportRequest(name, query string) *http.Request {
	return withRouteParams(
		httptest.NewRequest(http.MethodGet, "/api/connections/conn-1/objects/"+name+"/fields.csv?"+query, nil),
		map[string]string{"id": "conn-1", "name": name},
	)
}

func TestExportFieldsHandler(t *testing.T) {
	t.Parallel()

	fields := url.QueryEscape(`["user_id","items[].id"]`)
	tests := []struct {
		name       string
		conn       connector.Connector
		query      string
		wantStatus int
		wantBody   string
	}{
		{name: "fields missing", conn: &testFieldExporter{}, query: "", wantStatus: http.StatusBadRequest},
		{name: "fields not JSON", conn: &testFieldExporter{}, query: "fields=user_id", wantStatus: http.StatusBadRequest},
		{name: "fields empty", conn: &testFieldExporter{}, query: "fields=%5B%5D", wantStatus: http.StatusBadRequest},
		{name: "filters not JSON", conn: &testFieldExporter{}, query: "fields=" + fields + "&filters=nope", wantStatus: http.StatusBadRequest},
		{name: "source cannot export", conn: &testObjectsConnector{}, query: "fields=" + fields, wantStatus: http.StatusBadRequest},
		{name: "connector rejects before the first row", conn: &testFieldExporter{failBefore: fmt.Errorf("%w: topic gone", connector.ErrRelationNotFound)}, query: "fields=" + fields, wantStatus: http.StatusNotFound},
		{name: "no rows still writes the header", conn: &testFieldExporter{}, query: "fields=" + fields, wantStatus: http.StatusOK, wantBody: "user_id,items[].id\n"},
		{
			name:       "rows are CSV-escaped",
			conn:       &testFieldExporter{rows: [][]string{{"9007199254740993", "[1,2]"}, {"a,b", "say \"hi\""}}},
			query:      "fields=" + fields,
			wantStatus: http.StatusOK,
			wantBody:   "user_id,items[].id\n9007199254740993,\"[1,2]\"\n\"a,b\",\"say \"\"hi\"\"\"\n",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			rec := httptest.NewRecorder()
			newFieldExportHandler(tt.conn).ExportFields(rec, fieldExportRequest("events.v1", tt.query))

			if rec.Code != tt.wantStatus {
				t.Fatalf("status %d, want %d, body %s", rec.Code, tt.wantStatus, rec.Body.String())
			}
			if tt.wantStatus != http.StatusOK {
				var body map[string]any
				if err := json.NewDecoder(rec.Body).Decode(&body); err != nil || body["error"] == nil {
					t.Fatalf("error response is not {\"error\":...}: %v %s", err, rec.Body.String())
				}
				return
			}
			if got := rec.Header().Get("Content-Type"); got != "text/csv; charset=utf-8" {
				t.Errorf("Content-Type %q", got)
			}
			disposition := rec.Header().Get("Content-Disposition")
			if !regexp.MustCompile(`^attachment; filename="events\.v1-\d{8}-\d{6}\.csv"$`).MatchString(disposition) {
				t.Errorf("Content-Disposition %q", disposition)
			}
			if rec.Body.String() != tt.wantBody {
				t.Errorf("body %q, want %q", rec.Body.String(), tt.wantBody)
			}
		})
	}
}

func TestExportFieldsHandlerPassesTheRequestThrough(t *testing.T) {
	t.Parallel()

	conn := &testFieldExporter{}
	query := "fields=" + url.QueryEscape(`["user_id"]`) + "&filters=" + url.QueryEscape(`[{"column":"partition","op":"eq","value":"2"}]`)
	rec := httptest.NewRecorder()
	newFieldExportHandler(conn).ExportFields(rec, fieldExportRequest("team%2Fevents", query))

	if conn.topic != "team/events" {
		t.Errorf("topic %q, want the decoded name", conn.topic)
	}
	if len(conn.fields) != 1 || conn.fields[0] != "user_id" {
		t.Errorf("fields %v", conn.fields)
	}
	if len(conn.filters) != 1 || conn.filters[0].Column != "partition" || conn.filters[0].Value != "2" {
		t.Errorf("filters %v", conn.filters)
	}
	if disposition := rec.Header().Get("Content-Disposition"); !strings.Contains(disposition, `filename="team_events-`) {
		t.Errorf("Content-Disposition %q keeps a path separator", disposition)
	}
}

// A broker failure after rows went out must not end the response cleanly: a
// truncated CSV that looks complete is worse than a failed download.
func TestExportFieldsHandlerAbortsAfterTheFirstRow(t *testing.T) {
	t.Parallel()

	conn := &testFieldExporter{rows: [][]string{{"1"}}, failAfter: errors.New("broker went away")}
	handler := newFieldExportHandler(conn)
	server := httptest.NewServer(middleware.Recovery(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		handler.ExportFields(w, withRouteParams(r, map[string]string{"id": "conn-1", "name": "events"}))
	})))
	defer server.Close()

	// Either is a failed download: the request itself fails when nothing had
	// been flushed yet, the body read fails when rows were already on the wire.
	resp, err := http.Get(server.URL + "/?fields=" + url.QueryEscape(`["user_id"]`))
	if err != nil {
		return
	}
	defer resp.Body.Close()
	if _, err := io.ReadAll(resp.Body); err == nil {
		t.Fatalf("download completed with status %d; a failed export must break it", resp.StatusCode)
	}
}
