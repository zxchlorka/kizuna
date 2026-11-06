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

func TestArrangeConnections(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name     string
		folderID string
		ids      []string
		wantErr  error
	}{
		{name: "reorder inside a folder", folderID: "env", ids: []string{"pg-2"}},
		{name: "move in at a position", folderID: "project", ids: []string{"pg-2", "pg-1"}},
		{name: "unknown folder", folderID: "nope", ids: []string{"pg-1"}, wantErr: ErrFolderNotFound},
		{name: "unknown connection", folderID: "project", ids: []string{"pg-1", "pg-9"}, wantErr: ErrConnectionNotFound},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			cfg := folderTree()
			err := cfg.ArrangeConnections(tc.folderID, tc.ids)
			if !errors.Is(err, tc.wantErr) {
				t.Fatalf("err = %v, want %v", err, tc.wantErr)
			}
			if err != nil {
				// All or nothing: a bad id must not leave half the list moved.
				if got, _ := cfg.GetConnection("pg-1"); got.FolderID != "project" || got.Position != 0 {
					t.Fatalf("failed arrange changed pg-1: %#v", got)
				}
				return
			}
			for i, id := range tc.ids {
				got, _ := cfg.GetConnection(id)
				if got.FolderID != tc.folderID || got.Position != i+1 {
					t.Fatalf("%s: folder=%q position=%d, want %q %d", id, got.FolderID, got.Position, tc.folderID, i+1)
				}
			}
		})
	}
}

func TestSetConnectionFolderAppendsAtTheEnd(t *testing.T) {
	t.Parallel()

	cfg := folderTree()
	if err := cfg.ArrangeConnections("project", []string{"pg-1"}); err != nil {
		t.Fatal(err)
	}
	if err := cfg.SetConnectionFolder("pg-2", "project"); err != nil {
		t.Fatal(err)
	}
	if got, _ := cfg.GetConnection("pg-2"); got.Position != 2 {
		t.Fatalf("moved connection got position %d, want 2 (after pg-1)", got.Position)
	}
}

func TestArrangeFolders(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name     string
		parentID string
		ids      []string
		wantErr  error
	}{
		{name: "reorder top level", parentID: "", ids: []string{"other", "team"}},
		{name: "pull a nested folder out to top level", parentID: "", ids: []string{"team", "env", "other"}},
		{name: "move in at a position", parentID: "project", ids: []string{"other", "env"}},
		{name: "into its own subfolder", parentID: "env", ids: []string{"team"}, wantErr: ErrFolderCycle},
		{name: "into itself", parentID: "team", ids: []string{"team"}, wantErr: ErrFolderCycle},
		{name: "unknown parent", parentID: "nope", ids: []string{"team"}, wantErr: ErrFolderNotFound},
		{name: "unknown folder", parentID: "", ids: []string{"team", "nope"}, wantErr: ErrFolderNotFound},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			cfg := folderTree()
			err := cfg.ArrangeFolders(tc.parentID, tc.ids)
			if !errors.Is(err, tc.wantErr) {
				t.Fatalf("err = %v, want %v", err, tc.wantErr)
			}
			byID := map[string]FolderConfig{}
			for _, f := range cfg.GetFolders() {
				byID[f.ID] = f
			}
			if err != nil {
				// All or nothing: a bad id must not leave half the list moved.
				if byID["team"].Position != 0 || byID["env"].ParentID != "project" {
					t.Fatalf("failed arrange changed folders: %#v", byID)
				}
				return
			}
			for i, id := range tc.ids {
				if got := byID[id]; got.ParentID != tc.parentID || got.Position != i+1 {
					t.Fatalf("%s: parent=%q position=%d, want %q %d", id, got.ParentID, got.Position, tc.parentID, i+1)
				}
			}
		})
	}
}

func TestNewAndMovedFoldersGoToTheEnd(t *testing.T) {
	t.Parallel()

	cfg := folderTree()
	if err := cfg.ArrangeFolders("", []string{"other", "team"}); err != nil {
		t.Fatal(err)
	}
	added, err := cfg.AddFolder(FolderConfig{ID: "new", Name: "A first by name"})
	if err != nil {
		t.Fatal(err)
	}
	if added.Position != 3 {
		t.Fatalf("new folder position = %d, want 3", added.Position)
	}
	moved, err := cfg.UpdateFolder("env", "Env", "")
	if err != nil {
		t.Fatal(err)
	}
	if moved.Position != 4 {
		t.Fatalf("moved folder position = %d, want 4", moved.Position)
	}
	renamed, _ := cfg.UpdateFolder("other", "Renamed", "")
	if renamed.Position != 1 {
		t.Fatalf("rename in place moved the folder to %d", renamed.Position)
	}
}

func TestLoadOrdersFoldersByNameOnce(t *testing.T) {
	t.Parallel()

	path := filepath.Join(t.TempDir(), "config.json")
	data := `{"folders": [
		{"id": "z", "name": "zeta"},
		{"id": "a", "name": "Alpha"},
		{"id": "p", "name": "Placed", "position": 1},
		{"id": "kid", "name": "Kid", "parent_id": "a"}
	]}`
	if err := os.WriteFile(path, []byte(data), 0o600); err != nil {
		t.Fatal(err)
	}
	cfg, err := Load(path)
	if err != nil {
		t.Fatal(err)
	}
	got := map[string]int{}
	for _, f := range cfg.GetFolders() {
		got[f.ID] = f.Position
	}
	want := map[string]int{"p": 1, "a": 2, "z": 3, "kid": 1}
	for id, pos := range want {
		if got[id] != pos {
			t.Errorf("%s: position = %d, want %d", id, got[id], pos)
		}
	}
}
