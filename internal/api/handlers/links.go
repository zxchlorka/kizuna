package handlers

import (
	"encoding/json"
	"log/slog"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/qsnake66/infraview/internal/config"
)

type LinksHandler struct {
	cfg *config.AppConfig
}

func NewLinksHandler(cfg *config.AppConfig) *LinksHandler {
	return &LinksHandler{cfg: cfg}
}

type linkRequest struct {
	Name         string `json:"name"`
	SourceConnID string `json:"source_conn_id"`
	Topic        string `json:"topic"`
	Field        string `json:"field"`
	TargetConnID string `json:"target_conn_id"`
	TargetKind   string `json:"target_kind"`
	KeyPattern   string `json:"key_pattern"`
	Table        string `json:"table"`
	Column       string `json:"column"`
}

func (h *LinksHandler) List(w http.ResponseWriter, r *http.Request) {
	sourceConnID := r.URL.Query().Get("source_conn_id")
	topic := r.URL.Query().Get("topic")

	var links []config.LinkConfig
	if sourceConnID != "" && topic != "" {
		links = h.cfg.GetLinksFor(sourceConnID, topic)
	} else {
		links = h.cfg.GetLinks()
	}
	writeJSON(w, http.StatusOK, links)
}

func (h *LinksHandler) Create(w http.ResponseWriter, r *http.Request) {
	var req linkRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if err := h.validate(req); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}

	link := config.LinkConfig{
		ID:           generateID(),
		Name:         strings.TrimSpace(req.Name),
		SourceConnID: req.SourceConnID,
		Topic:        req.Topic,
		Field:        strings.TrimSpace(req.Field),
		TargetConnID: req.TargetConnID,
		TargetKind:   req.TargetKind,
		KeyPattern:   strings.TrimSpace(req.KeyPattern),
		Table:        strings.TrimSpace(req.Table),
		Column:       strings.TrimSpace(req.Column),
	}
	h.cfg.AddLink(link)

	if err := h.cfg.Save(h.cfg.GetPath()); err != nil {
		slog.Error("failed to save config", "error", err)
		writeError(w, http.StatusInternalServerError, "failed to save configuration")
		return
	}
	writeJSON(w, http.StatusCreated, link)
}

func (h *LinksHandler) Delete(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	if !h.cfg.RemoveLink(id) {
		writeError(w, http.StatusNotFound, "link not found")
		return
	}
	if err := h.cfg.Save(h.cfg.GetPath()); err != nil {
		slog.Error("failed to save config", "error", err)
		writeError(w, http.StatusInternalServerError, "failed to save configuration")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (h *LinksHandler) validate(req linkRequest) error {
	if strings.TrimSpace(req.SourceConnID) == "" || strings.TrimSpace(req.Topic) == "" || strings.TrimSpace(req.Field) == "" {
		return errBadLink("source_conn_id, topic and field are required")
	}
	if _, ok := h.cfg.GetConnection(req.SourceConnID); !ok {
		return errBadLink("source connection not found")
	}
	if _, ok := h.cfg.GetConnection(req.TargetConnID); !ok {
		return errBadLink("target connection not found")
	}
	switch req.TargetKind {
	case "redis":
		if strings.Count(req.KeyPattern, "*") != 1 {
			return errBadLink("redis key_pattern must contain exactly one '*'")
		}
	case "postgres":
		if strings.TrimSpace(req.Table) == "" || strings.TrimSpace(req.Column) == "" {
			return errBadLink("postgres link requires table and column")
		}
	default:
		return errBadLink("target_kind must be 'redis' or 'postgres'")
	}
	return nil
}

type badLinkError struct{ msg string }

func (e badLinkError) Error() string { return e.msg }

func errBadLink(msg string) error { return badLinkError{msg: msg} }
