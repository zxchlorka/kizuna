package handlers

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/zxchlorka/kizuna/internal/config"
)

func newFolderRequest(method, id, body string) *http.Request {
	req := httptest.NewRequest(method, "/", strings.NewReader(body))
	rctx := chi.NewRouteContext()
	rctx.URLParams.Add("id", id)
	return req.WithContext(context.WithValue(req.Context(), chi.RouteCtxKey, rctx))
}

func TestFolderEndpoints(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name       string
		call       func(*ConnectionsHandler, *FoldersHandler, http.ResponseWriter)
		wantStatus int
	}{
		{
			name: "create",
			call: func(_ *ConnectionsHandler, f *FoldersHandler, w http.ResponseWriter) {
				f.Create(w, newFolderRequest(http.MethodPost, "", `{"name":" Billing ","parent_id":"team"}`))
			},
			wantStatus: http.StatusCreated,
		},
		{
			name: "create without a name",
			call: func(_ *ConnectionsHandler, f *FoldersHandler, w http.ResponseWriter) {
				f.Create(w, newFolderRequest(http.MethodPost, "", `{"name":"  "}`))
			},
			wantStatus: http.StatusBadRequest,
		},
		{
			name: "create under a missing parent",
			call: func(_ *ConnectionsHandler, f *FoldersHandler, w http.ResponseWriter) {
				f.Create(w, newFolderRequest(http.MethodPost, "", `{"name":"x","parent_id":"nope"}`))
			},
			wantStatus: http.StatusNotFound,
		},
		{
			name: "move into own subfolder",
			call: func(_ *ConnectionsHandler, f *FoldersHandler, w http.ResponseWriter) {
				f.Update(w, newFolderRequest(http.MethodPut, "team", `{"name":"Team","parent_id":"project"}`))
			},
			wantStatus: http.StatusBadRequest,
		},
		{
			name: "delete missing folder",
			call: func(_ *ConnectionsHandler, f *FoldersHandler, w http.ResponseWriter) {
				f.Delete(w, newFolderRequest(http.MethodDelete, "nope", ""))
			},
			wantStatus: http.StatusNotFound,
		},
		{
			name: "move connection into folder",
			call: func(c *ConnectionsHandler, _ *FoldersHandler, w http.ResponseWriter) {
				c.UpdateFolder(w, newFolderRequest(http.MethodPut, "pg-1", `{"folder_id":"project"}`))
			},
			wantStatus: http.StatusOK,
		},
		{
			name: "move connection into missing folder",
			call: func(c *ConnectionsHandler, _ *FoldersHandler, w http.ResponseWriter) {
				c.UpdateFolder(w, newFolderRequest(http.MethodPut, "pg-1", `{"folder_id":"nope"}`))
			},
			wantStatus: http.StatusNotFound,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			conns := newTestConnectionsHandler(t, []config.ConnectionConfig{{ID: "pg-1", Name: "orders", Type: "postgres"}})
			conns.cfg.Folders = []config.FolderConfig{{ID: "team", Name: "Team"}, {ID: "project", Name: "Project", ParentID: "team"}}
			rec := httptest.NewRecorder()

			tc.call(conns, NewFoldersHandler(conns.cfg), rec)

			if rec.Code != tc.wantStatus {
				t.Fatalf("status = %d, want %d (%s)", rec.Code, tc.wantStatus, rec.Body.String())
			}
		})
	}
}

func TestFoldersPersistAcrossReload(t *testing.T) {
	t.Parallel()

	conns := newTestConnectionsHandler(t, []config.ConnectionConfig{{ID: "pg-1", Name: "orders", Type: "postgres"}})
	folders := NewFoldersHandler(conns.cfg)
	rec := httptest.NewRecorder()
	folders.Create(rec, newFolderRequest(http.MethodPost, "", `{"name":"Team"}`))
	created := conns.cfg.GetFolders()[0]
	conns.UpdateFolder(httptest.NewRecorder(), newFolderRequest(http.MethodPut, "pg-1", `{"folder_id":"`+created.ID+`"}`))

	reloaded, err := config.Load(conns.cfg.GetPath())
	if err != nil {
		t.Fatalf("reload: %v", err)
	}
	if got := reloaded.GetFolders(); len(got) != 1 || got[0].Name != "Team" {
		t.Fatalf("folders after reload: %#v", got)
	}
	if conn, _ := reloaded.GetConnection("pg-1"); conn.FolderID != created.ID {
		t.Fatalf("folder_id after reload = %q", conn.FolderID)
	}
}
