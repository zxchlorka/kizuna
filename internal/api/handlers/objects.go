package handlers

import (
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/qsnake66/infraview/internal/config"
	"github.com/qsnake66/infraview/internal/connector"
)

type ObjectsHandler struct {
	cfg     *config.AppConfig
	manager *connector.ConnectionManager
}

func NewObjectsHandler(cfg *config.AppConfig, manager *connector.ConnectionManager) *ObjectsHandler {
	return &ObjectsHandler{cfg: cfg, manager: manager}
}

func (h *ObjectsHandler) ListObjects(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	path := r.URL.Query().Get("path")

	c, err := h.manager.Get(r.Context(), id)
	if err != nil {
		writeConnectorError(w, err)
		return
	}

	objects, err := c.ListObjects(r.Context(), path)
	if err != nil {
		writeConnectorError(w, err)
		return
	}

	writeJSON(w, http.StatusOK, objects)
}

func (h *ObjectsHandler) GetSchema(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	name := chi.URLParam(r, "name")

	c, err := h.manager.Get(r.Context(), id)
	if err != nil {
		writeConnectorError(w, err)
		return
	}

	schema, err := c.GetSchema(r.Context(), name)
	if err != nil {
		writeConnectorError(w, err)
		return
	}

	writeJSON(w, http.StatusOK, schema)
}

func (h *ObjectsHandler) GetObjectInfo(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	name := chi.URLParam(r, "name")

	c, err := h.manager.Get(r.Context(), id)
	if err != nil {
		writeConnectorError(w, err)
		return
	}

	info, err := c.GetObjectInfo(r.Context(), name)
	if err != nil {
		writeConnectorError(w, err)
		return
	}

	writeJSON(w, http.StatusOK, info)
}
