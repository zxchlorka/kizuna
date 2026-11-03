package config

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
)

// Tree used by every case: team -> project -> env, plus a separate "other".
func folderTree() *AppConfig {
	return &AppConfig{
		Folders: []FolderConfig{
			{ID: "team", Name: "Team"},
			{ID: "project", Name: "Project", ParentID: "team"},
			{ID: "env", Name: "Env", ParentID: "project"},
			{ID: "other", Name: "Other"},
		},
		Connections: []ConnectionConfig{
			{ID: "pg-1", FolderID: "project"},
			{ID: "pg-2", FolderID: "env"},
		},
	}
}

func TestUpdateFolder(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name     string
		id       string
		parentID string
		wantErr  error
	}{
		{name: "rename in place", id: "project", parentID: "team"},
		{name: "move to top level", id: "env", parentID: ""},
		{name: "move under a sibling branch", id: "project", parentID: "other"},
		{name: "into itself", id: "team", parentID: "team", wantErr: ErrFolderCycle},
		{name: "into its grandchild", id: "team", parentID: "env", wantErr: ErrFolderCycle},
		{name: "unknown parent", id: "team", parentID: "nope", wantErr: ErrFolderNotFound},
		{name: "unknown folder", id: "nope", parentID: "", wantErr: ErrFolderNotFound},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			cfg := folderTree()
			got, err := cfg.UpdateFolder(tc.id, "Renamed", tc.parentID)
			if !errors.Is(err, tc.wantErr) {
				t.Fatalf("err = %v, want %v", err, tc.wantErr)
			}
			if err != nil {
				return
			}
			if got.Name != "Renamed" || got.ParentID != tc.parentID {
				t.Fatalf("got %#v", got)
			}
		})
	}
}

func TestUpdateFolderSurvivesLoopInConfig(t *testing.T) {
	t.Parallel()

	cfg := &AppConfig{Folders: []FolderConfig{
		{ID: "a", ParentID: "b"},
		{ID: "b", ParentID: "a"},
		{ID: "c"},
	}}
	if _, err := cfg.UpdateFolder("c", "C", "a"); err != nil {
		t.Fatalf("a loop elsewhere in the tree must not block or hang the move: %v", err)
	}
}

func TestRemoveFolderLiftsContentsIntoParent(t *testing.T) {
	t.Parallel()

	cfg := folderTree()
	if !cfg.RemoveFolder("project") {
		t.Fatal("RemoveFolder returned false for an existing folder")
	}

	parents := map[string]string{}
	for _, f := range cfg.GetFolders() {
		parents[f.ID] = f.ParentID
	}
	if _, ok := parents["project"]; ok {
		t.Fatal("folder still stored")
	}
	if parents["env"] != "team" {
		t.Fatalf("subfolder lifted to %q, want team", parents["env"])
	}
	folders := map[string]string{}
	for _, c := range cfg.GetConnections() {
		folders[c.ID] = c.FolderID
	}
	if folders["pg-1"] != "team" || folders["pg-2"] != "env" {
		t.Fatalf("connections after delete: %v", folders)
	}
	if cfg.RemoveFolder("project") {
		t.Fatal("RemoveFolder returned true for a missing folder")
	}
}

func TestSetConnectionFolder(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name     string
		connID   string
		folderID string
		wantErr  error
	}{
		{name: "into a folder", connID: "pg-1", folderID: "other"},
		{name: "to top level", connID: "pg-1", folderID: ""},
		{name: "unknown folder", connID: "pg-1", folderID: "nope", wantErr: ErrFolderNotFound},
		{name: "unknown connection", connID: "pg-9", folderID: "other", wantErr: ErrConnectionNotFound},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			cfg := folderTree()
			err := cfg.SetConnectionFolder(tc.connID, tc.folderID)
			if !errors.Is(err, tc.wantErr) {
				t.Fatalf("err = %v, want %v", err, tc.wantErr)
			}
			if err != nil {
				return
			}
			if got, _ := cfg.GetConnection(tc.connID); got.FolderID != tc.folderID {
				t.Fatalf("folder_id = %q, want %q", got.FolderID, tc.folderID)
			}
		})
	}
}

func TestLoadRepairsHandEditedFolders(t *testing.T) {
	t.Parallel()

	path := filepath.Join(t.TempDir(), "config.json")
	data := `{
		"folders": [
			{"id": "a", "name": "A", "parent_id": "b"},
			{"id": "b", "name": "B", "parent_id": "a"},
			{"id": "self", "name": "Self", "parent_id": "self"},
			{"id": "orphan", "name": "Orphan", "parent_id": "gone"},
			{"id": "ok", "name": "Ok", "parent_id": "a"}
		],
		"connections": [
			{"id": "pg-1", "folder_id": "gone"},
			{"id": "pg-2", "folder_id": "b"}
		]
	}`
	if err := os.WriteFile(path, []byte(data), 0o600); err != nil {
		t.Fatal(err)
	}

	cfg, err := Load(path)
	if err != nil {
		t.Fatalf("load: %v", err)
	}

	parents := map[string]string{}
	for _, f := range cfg.GetFolders() {
		parents[f.ID] = f.ParentID
	}
	want := map[string]string{"a": "", "b": "a", "self": "", "orphan": "", "ok": "a"}
	for id, parent := range want {
		if parents[id] != parent {
			t.Errorf("%s: parent = %q, want %q", id, parents[id], parent)
		}
	}
	if c, _ := cfg.GetConnection("pg-1"); c.FolderID != "" {
		t.Errorf("connection in a missing folder kept folder_id %q", c.FolderID)
	}
	if c, _ := cfg.GetConnection("pg-2"); c.FolderID != "b" {
		t.Errorf("valid folder_id changed to %q", c.FolderID)
	}
}
