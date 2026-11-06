package handlers

import (
	"errors"
	"log/slog"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/zxchlorka/kizuna/internal/config"
)

const maxFolderNameLength = 100

type FoldersHandler struct {
	cfg *config.AppConfig
}

func NewFoldersHandler(cfg *config.AppConfig) *FoldersHandler {
	return &FoldersHandler{cfg: cfg}
}

type folderRequest struct {
	Name     string `json:"name"`
	ParentID string `json:"parent_id"`
}

func (r folderRequest) normalizedName() (string, error) {
	name := strings.TrimSpace(r.Name)
	if name == "" {
		return "", errors.New("folder name is required")
	}
	if len([]rune(name)) > maxFolderNameLength {
		return "", errors.New("folder name is too long")
	}
	return name, nil
}

func (h *FoldersHandler) List(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, h.cfg.GetFolders())
}

func (h *FoldersHandler) Create(w http.ResponseWriter, r *http.Request) {
	var req folderRequest
	if !decodeJSON(w, r, &req) {
		return
	}
	name, err := req.normalizedName()
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}

	folder, err := h.cfg.AddFolder(config.FolderConfig{ID: generateID(), Name: name, ParentID: req.ParentID})
	if err != nil {
		writeFolderError(w, err)
		return
	}
	if !h.save(w) {
		return
	}
	writeJSON(w, http.StatusCreated, folder)
}

// Update renames a folder and moves it: the body carries both, so a rename
// sends the current parent_id and a move sends the current name.
func (h *FoldersHandler) Update(w http.ResponseWriter, r *http.Request) {
	var req folderRequest
	if !decodeJSON(w, r, &req) {
		return
	}
	name, err := req.normalizedName()
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}

	folder, err := h.cfg.UpdateFolder(chi.URLParam(r, "id"), name, req.ParentID)
	if err != nil {
		writeFolderError(w, err)
		return
	}
	if !h.save(w) {
		return
	}
	writeJSON(w, http.StatusOK, folder)
}

// Arrange sets the order of a folder's subfolders ("" = top level); a folder
// dragged in from elsewhere moves there on the way.
func (h *FoldersHandler) Arrange(w http.ResponseWriter, r *http.Request) {
	var req struct {
		ParentID  string   `json:"parent_id"`
		FolderIDs []string `json:"folder_ids"`
	}
	if !decodeJSON(w, r, &req) {
		return
	}
	if len(req.FolderIDs) == 0 {
		writeError(w, http.StatusBadRequest, "folder_ids are required")
		return
	}
	if err := h.cfg.ArrangeFolders(req.ParentID, req.FolderIDs); err != nil {
		writeFolderError(w, err)
		return
	}
	if !h.save(w) {
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (h *FoldersHandler) Delete(w http.ResponseWriter, r *http.Request) {
	if !h.cfg.RemoveFolder(chi.URLParam(r, "id")) {
		writeError(w, http.StatusNotFound, config.ErrFolderNotFound.Error())
		return
	}
	if !h.save(w) {
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (h *FoldersHandler) save(w http.ResponseWriter) bool {
	if err := h.cfg.Save(h.cfg.GetPath()); err != nil {
		slog.Error("failed to save config", "error", err)
		writeError(w, http.StatusInternalServerError, "failed to save configuration")
		return false
	}
	return true
}

func writeFolderError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, config.ErrFolderNotFound), errors.Is(err, config.ErrConnectionNotFound):
		writeError(w, http.StatusNotFound, err.Error())
	case errors.Is(err, config.ErrFolderCycle):
		writeError(w, http.StatusBadRequest, err.Error())
	default:
		writeError(w, http.StatusInternalServerError, err.Error())
	}
}
