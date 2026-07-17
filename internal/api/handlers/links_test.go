package handlers

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/zxchlorka/kizuna/internal/config"
)

func newLinksTestConfig(t *testing.T) *config.AppConfig {
	t.Helper()
	cfg := &config.AppConfig{}
	cfg.SetPathForTest(filepath.Join(t.TempDir(), "config.json"))
	cfg.Connections = []config.ConnectionConfig{
		{ID: "kafka-1", Type: "kafka"},
		{ID: "redis-1", Type: "redis"},
	}
	return cfg
}

func TestLinksHandlerCreateValidatesRedisPattern(t *testing.T) {
	cfg := newLinksTestConfig(t)
	h := NewLinksHandler(cfg)

	body, _ := json.Marshal(map[string]any{
		"source_conn_id": "kafka-1", "source_kind": "kafka", "source_scope": "cookies", "source_field": "user_id",
		"target_conn_id": "redis-1", "target_kind": "redis", "key_pattern": "w:no-star",
	})
	req := httptest.NewRequest(http.MethodPost, "/api/links", bytes.NewReader(body))
	rec := httptest.NewRecorder()
	h.Create(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for pattern without '*', got %d", rec.Code)
	}
}

func TestLinksHandlerCreateListDelete(t *testing.T) {
	cfg := newLinksTestConfig(t)
	h := NewLinksHandler(cfg)

	body, _ := json.Marshal(map[string]any{
		"source_conn_id": "kafka-1", "source_kind": "kafka", "source_scope": "cookies", "source_field": "user_id",
		"target_conn_id": "redis-1", "target_kind": "redis", "key_pattern": "w:*",
	})
	rec := httptest.NewRecorder()
	h.Create(rec, httptest.NewRequest(http.MethodPost, "/api/links", bytes.NewReader(body)))
	if rec.Code != http.StatusCreated {
		t.Fatalf("create: expected 201, got %d (%s)", rec.Code, rec.Body.String())
	}
	var created config.LinkConfig
	if err := json.Unmarshal(rec.Body.Bytes(), &created); err != nil {
		t.Fatalf("decode created: %v", err)
	}
	if created.ID == "" {
		t.Fatalf("expected generated id")
	}

	rec = httptest.NewRecorder()
	h.List(rec, httptest.NewRequest(http.MethodGet, "/api/links?source_conn_id=kafka-1&scope=cookies", nil))
	var listed []config.LinkConfig
	if err := json.Unmarshal(rec.Body.Bytes(), &listed); err != nil {
		t.Fatalf("decode list: %v", err)
	}
	if len(listed) != 1 {
		t.Fatalf("expected 1 listed link, got %d", len(listed))
	}

	rec = httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodDelete, "/api/links/"+created.ID, nil)
	rctx := chi.NewRouteContext()
	rctx.URLParams.Add("id", created.ID)
	req = req.WithContext(context.WithValue(req.Context(), chi.RouteCtxKey, rctx))
	h.Delete(rec, req)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("delete: expected 204, got %d", rec.Code)
	}
}

func TestLinksHandlerUpdate(t *testing.T) {
	cfg := newLinksTestConfig(t)
	h := NewLinksHandler(cfg)

	body, _ := json.Marshal(map[string]any{
		"source_conn_id": "kafka-1", "source_kind": "kafka", "source_scope": "cookies", "source_field": "user_id",
		"target_conn_id": "redis-1", "target_kind": "redis", "key_pattern": "w:*",
	})
	rec := httptest.NewRecorder()
	h.Create(rec, httptest.NewRequest(http.MethodPost, "/api/links", bytes.NewReader(body)))
	var created config.LinkConfig
	_ = json.Unmarshal(rec.Body.Bytes(), &created)

	put := func(id string, payload map[string]any) *httptest.ResponseRecorder {
		raw, _ := json.Marshal(payload)
		rec := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodPut, "/api/links/"+id, bytes.NewReader(raw))
		rctx := chi.NewRouteContext()
		rctx.URLParams.Add("id", id)
		req = req.WithContext(context.WithValue(req.Context(), chi.RouteCtxKey, rctx))
		h.Update(rec, req)
		return rec
	}

	rec = put(created.ID, map[string]any{
		"source_conn_id": "kafka-1", "source_kind": "kafka", "source_scope": "cookies", "source_field": "uid",
		"target_conn_id": "redis-1", "target_kind": "redis", "key_pattern": "c:*",
	})
	if rec.Code != http.StatusOK {
		t.Fatalf("update: expected 200, got %d (%s)", rec.Code, rec.Body.String())
	}
	var updated config.LinkConfig
	_ = json.Unmarshal(rec.Body.Bytes(), &updated)
	if updated.ID != created.ID || updated.KeyPattern != "c:*" || updated.SourceField != "uid" {
		t.Fatalf("update did not apply / preserve id: %#v", updated)
	}

	if rec := put(created.ID, map[string]any{
		"source_conn_id": "kafka-1", "source_kind": "kafka", "source_scope": "cookies", "source_field": "uid",
		"target_conn_id": "redis-1", "target_kind": "redis", "key_pattern": "no-star",
	}); rec.Code != http.StatusBadRequest {
		t.Fatalf("invalid update: expected 400, got %d", rec.Code)
	}

	if rec := put("missing", map[string]any{
		"source_conn_id": "kafka-1", "source_kind": "kafka", "source_scope": "cookies", "source_field": "uid",
		"target_conn_id": "redis-1", "target_kind": "redis", "key_pattern": "w:*",
	}); rec.Code != http.StatusNotFound {
		t.Fatalf("unknown id: expected 404, got %d", rec.Code)
	}
}

func TestLinksHandlerValidatesGeneralizedKinds(t *testing.T) {
	cfg := newLinksTestConfig(t) // has kafka-1, redis-1
	h := NewLinksHandler(cfg)

	post := func(body map[string]any) int {
		raw, _ := json.Marshal(body)
		rec := httptest.NewRecorder()
		h.Create(rec, httptest.NewRequest(http.MethodPost, "/api/links", bytes.NewReader(raw)))
		return rec.Code
	}

	if code := post(map[string]any{
		"source_conn_id": "redis-1", "source_kind": "redis", "source_scope": "profile:*",
		"source_extract": "value_field", "source_field": "user_id",
		"target_conn_id": "kafka-1", "target_kind": "kafka", "target_topic": "cookies", "target_field": "user_id",
	}); code != http.StatusCreated {
		t.Fatalf("redis->kafka: expected 201, got %d", code)
	}

	if code := post(map[string]any{
		"source_conn_id": "redis-1", "source_kind": "redis", "source_scope": "profile:*",
		"source_extract": "string_value",
		"target_conn_id": "kafka-1", "target_kind": "kafka", "target_topic": "cookies",
	}); code != http.StatusBadRequest {
		t.Fatalf("kafka target without target_field: expected 400, got %d", code)
	}

	if code := post(map[string]any{
		"source_conn_id": "redis-1", "source_kind": "redis", "source_scope": "profile:*",
		"source_extract": "value_field",
		"target_conn_id": "redis-1", "target_kind": "redis", "key_pattern": "w:*",
	}); code != http.StatusBadRequest {
		t.Fatalf("redis value_field without source_field: expected 400, got %d", code)
	}
}

func TestLinksHandlerAcceptsMemberExtract(t *testing.T) {
	cfg := newLinksTestConfig(t)
	h := NewLinksHandler(cfg)

	body, _ := json.Marshal(map[string]any{
		"source_conn_id": "redis-1", "source_kind": "redis", "source_scope": "w:*",
		"source_extract": "member",
		"target_conn_id": "redis-1", "target_kind": "redis", "key_pattern": "profile:*",
	})
	rec := httptest.NewRecorder()
	h.Create(rec, httptest.NewRequest(http.MethodPost, "/api/links", bytes.NewReader(body)))
	if rec.Code != http.StatusCreated {
		t.Fatalf("member extract: expected 201, got %d (%s)", rec.Code, rec.Body.String())
	}
}
