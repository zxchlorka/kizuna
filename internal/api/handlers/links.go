package handlers

import (
	"encoding/json"
	"log/slog"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/zxchlorka/kizuna/internal/config"
)

type LinksHandler struct {
	cfg *config.AppConfig
}

func NewLinksHandler(cfg *config.AppConfig) *LinksHandler {
	return &LinksHandler{cfg: cfg}
}

type linkRequest struct {
	Name          string `json:"name"`
	SourceConnID  string `json:"source_conn_id"`
	SourceKind    string `json:"source_kind"`
	SourceScope   string `json:"source_scope"`
	SourceField   string `json:"source_field"`
	SourceExtract string `json:"source_extract"`
	TargetConnID  string `json:"target_conn_id"`
	TargetKind    string `json:"target_kind"`
	TargetTopic   string `json:"target_topic"`
	TargetField   string `json:"target_field"`
	KeyPattern    string `json:"key_pattern"`
	Table         string `json:"table"`
	Column        string `json:"column"`
}

func (h *LinksHandler) List(w http.ResponseWriter, r *http.Request) {
	sourceConnID := r.URL.Query().Get("source_conn_id")
	scope := r.URL.Query().Get("scope")
	if scope == "" {
		scope = r.URL.Query().Get("topic")
	}

	var links []config.LinkConfig
	if sourceConnID != "" && scope != "" {
		links = h.cfg.GetLinksFor(sourceConnID, scope)
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
		ID:            generateID(),
		Name:          strings.TrimSpace(req.Name),
		SourceConnID:  req.SourceConnID,
		SourceKind:    req.SourceKind,
		SourceScope:   strings.TrimSpace(req.SourceScope),
		SourceField:   strings.TrimSpace(req.SourceField),
		SourceExtract: req.SourceExtract,
		TargetConnID:  req.TargetConnID,
		TargetKind:    req.TargetKind,
		TargetTopic:   strings.TrimSpace(req.TargetTopic),
		TargetField:   strings.TrimSpace(req.TargetField),
		KeyPattern:    strings.TrimSpace(req.KeyPattern),
		Table:         strings.TrimSpace(req.Table),
		Column:        strings.TrimSpace(req.Column),
	}
	h.cfg.AddLink(link)

	if err := h.cfg.Save(h.cfg.GetPath()); err != nil {
		slog.Error("failed to save config", "error", err)
		writeError(w, http.StatusInternalServerError, "failed to save configuration")
		return
	}
	writeJSON(w, http.StatusCreated, link)
}

func (h *LinksHandler) Update(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
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
		ID:            id,
		Name:          strings.TrimSpace(req.Name),
		SourceConnID:  req.SourceConnID,
		SourceKind:    req.SourceKind,
		SourceScope:   strings.TrimSpace(req.SourceScope),
		SourceField:   strings.TrimSpace(req.SourceField),
		SourceExtract: req.SourceExtract,
		TargetConnID:  req.TargetConnID,
		TargetKind:    req.TargetKind,
		TargetTopic:   strings.TrimSpace(req.TargetTopic),
		TargetField:   strings.TrimSpace(req.TargetField),
		KeyPattern:    strings.TrimSpace(req.KeyPattern),
		Table:         strings.TrimSpace(req.Table),
		Column:        strings.TrimSpace(req.Column),
	}
	if !h.cfg.UpdateLink(id, link) {
		writeError(w, http.StatusNotFound, "link not found")
		return
	}
	if err := h.cfg.Save(h.cfg.GetPath()); err != nil {
		slog.Error("failed to save config", "error", err)
		writeError(w, http.StatusInternalServerError, "failed to save configuration")
		return
	}
	writeJSON(w, http.StatusOK, link)
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
	if strings.TrimSpace(req.SourceConnID) == "" || strings.TrimSpace(req.SourceScope) == "" {
		return errBadLink("source_conn_id and source_scope are required")
	}
	if _, ok := h.cfg.GetConnection(req.SourceConnID); !ok {
		return errBadLink("source connection not found")
	}
	if _, ok := h.cfg.GetConnection(req.TargetConnID); !ok {
		return errBadLink("target connection not found")
	}

	switch req.SourceKind {
	case "kafka", "postgres":
		if strings.TrimSpace(req.SourceField) == "" {
			return errBadLink("source_field is required for kafka/postgres source")
		}
	case "redis":
		switch req.SourceExtract {
		case "value_field":
			if strings.TrimSpace(req.SourceField) == "" {
				return errBadLink("source_field is required for redis value_field extract")
			}
		case "key_capture":
			if strings.Count(req.SourceScope, "*") != 1 {
				return errBadLink("redis key_capture requires a source_scope with exactly one '*'")
			}
		case "string_value":
		case "member":
		default:
			return errBadLink("source_extract must be value_field, key_capture, string_value or member")
		}
	default:
		return errBadLink("source_kind must be kafka, redis or postgres")
	}

	switch req.TargetKind {
	case "redis":
		if strings.Count(req.KeyPattern, "*") != 1 {
			return errBadLink("redis key_pattern must contain exactly one '*'")
		}
	case "postgres":
		if strings.TrimSpace(req.Table) == "" || strings.TrimSpace(req.Column) == "" {
			return errBadLink("postgres target requires table and column")
		}
	case "kafka":
		if strings.TrimSpace(req.TargetTopic) == "" || strings.TrimSpace(req.TargetField) == "" {
			return errBadLink("kafka target requires target_topic and target_field")
		}
	default:
		return errBadLink("target_kind must be kafka, redis or postgres")
	}
	return nil
}

type badLinkError struct{ msg string }

func (e badLinkError) Error() string { return e.msg }

func errBadLink(msg string) error { return badLinkError{msg: msg} }
