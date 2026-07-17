package handlers

import (
	"log/slog"
	"net/http"
	"net/url"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/zxchlorka/kizuna/internal/config"
	"github.com/zxchlorka/kizuna/internal/connector"
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
	query := r.URL.Query()
	path := query.Get("path")
	start := time.Now()

	c, cancel, err := getConnector(r.Context(), h.manager, id)
	if err != nil {
		writeConnectorError(w, err)
		return
	}
	defer cancel()

	// paged=1 opts into the cursor-based envelope; the plain array contract
	// stays untouched for connectors without incremental listing (PostgreSQL).
	if query.Get("paged") == "1" {
		pager, ok := c.(connector.PagedObjectLister)
		if !ok {
			writeError(w, http.StatusBadRequest, "paged object listing is not supported for this connection")
			return
		}

		page, err := pager.ListObjectsPage(r.Context(), connector.ObjectPageOpts{
			Path:   path,
			Cursor: query.Get("cursor"),
			Node:   query.Get("node"),
		})
		if err != nil {
			writeConnectorError(w, err)
			return
		}

		logSlowObjectList(id, path, len(page.Objects), time.Since(start))
		writeJSON(w, http.StatusOK, page)
		return
	}

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
	name, err := url.PathUnescape(chi.URLParam(r, "name"))
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid object name")
		return
	}

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
	name, err := url.PathUnescape(chi.URLParam(r, "name"))
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid object name")
		return
	}

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
