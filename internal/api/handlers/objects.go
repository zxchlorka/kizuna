package handlers

import (
	"log/slog"
	"net/http"
	"time"

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
	start := time.Now()

	c, cancel, err := getConnector(r.Context(), h.manager, id)
	if err != nil {
		writeConnectorError(w, err)
		return
	}
	defer cancel()

	objects, err := c.ListObjects(r.Context(), path)
	if err != nil {
		writeConnectorError(w, err)
		return
	}

	logSlowObjectList(id, path, len(objects), time.Since(start))

	writeJSON(w, http.StatusOK, objects)
}

func (h *ObjectsHandler) GetSchema(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	name := chi.URLParam(r, "name")

	c, cancel, err := getConnector(r.Context(), h.manager, id)
	if err != nil {
		writeConnectorError(w, err)
		return
	}
	defer cancel()

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

	c, cancel, err := getConnector(r.Context(), h.manager, id)
	if err != nil {
		writeConnectorError(w, err)
		return
	}
	defer cancel()

	info, err := c.GetObjectInfo(r.Context(), name)
	if err != nil {
		writeConnectorError(w, err)
		return
	}

	writeJSON(w, http.StatusOK, info)
}

func logSlowObjectList(connectionID, path string, objectCount int, duration time.Duration) {
	if duration < 250*time.Millisecond {
		return
	}

	level := "root"
	if path != "" {
		level = "children"
	}

	slog.Info("slow object tree request",
		"connection_id", connectionID,
		"level", level,
		"path", path,
		"object_count", objectCount,
		"duration_ms", duration.Milliseconds(),
	)
}
