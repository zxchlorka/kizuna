package handlers

import (
	"encoding/csv"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/zxchlorka/kizuna/internal/connector"
)

// fieldExportFlushRows is how many rows go out per flush. The browser shows the
// download growing, and a cancelled one is noticed within a batch.
const fieldExportFlushRows = 1000

var unsafeFilenameChars = regexp.MustCompile(`[^A-Za-z0-9._-]`)

// ExportFields streams chosen JSON fields of a topic as a CSV download:
// GET /objects/{name}/fields.csv?fields=["user_id"]&filters=[...], with filters
// in the same shape GetData takes.
//
// The status line goes out with the first row. Until then any failure is an
// ordinary JSON error. After it the response is aborted instead, so the browser
// marks the download as failed rather than saving a truncated file that looks
// whole.
func (h *DataHandler) ExportFields(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	object, err := url.PathUnescape(chi.URLParam(r, "name"))
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid object name")
		return
	}
	if strings.TrimSpace(object) == "" {
		writeError(w, http.StatusBadRequest, "object is required")
		return
	}

	q := r.URL.Query()
	var fields []string
	if err := json.Unmarshal([]byte(q.Get("fields")), &fields); err != nil || len(fields) == 0 {
		writeError(w, http.StatusBadRequest, "fields must be a non-empty JSON array of field paths")
		return
	}
	var filters []connector.FilterExpr
	if raw := q.Get("filters"); raw != "" {
		if err := json.Unmarshal([]byte(raw), &filters); err != nil {
			writeError(w, http.StatusBadRequest, "invalid filters JSON: "+err.Error())
			return
		}
	}

	conn, cancel, err := getConnector(r.Context(), h.manager, id)
	if err != nil {
		writeConnectorError(w, err)
		return
	}
	defer cancel()

	exporter, ok := conn.(connector.KafkaFieldExporter)
	if !ok {
		writeError(w, http.StatusBadRequest, "this source cannot export fields")
		return
	}

	out := csv.NewWriter(w)
	started := false
	start := func() error {
		started = true
		filename := fmt.Sprintf("%s-%s.csv", unsafeFilenameChars.ReplaceAllString(object, "_"), time.Now().Format("20060102-150405"))
		w.Header().Set("Content-Type", "text/csv; charset=utf-8")
		w.Header().Set("Content-Disposition", fmt.Sprintf("attachment; filename=%q", filename))
		w.WriteHeader(http.StatusOK)
		return out.Write(fields)
	}

	rows := 0
	err = exporter.ExportFields(r.Context(), object, fields, filters, func(cells []string) error {
		if !started {
			if err := start(); err != nil {
				return err
			}
		}
		if err := out.Write(cells); err != nil {
			return err
		}
		rows++
		if rows%fieldExportFlushRows == 0 {
			out.Flush()
			return out.Error()
		}
		return nil
	})
	if err == nil && !started {
		err = start()
	}
	if err == nil {
		out.Flush()
		err = out.Error()
	}
	if err == nil {
		return
	}
	if !started {
		writeConnectorError(w, err)
		return
	}
	slog.Error("field export aborted", "connection", id, "topic", object, "rows", rows, "error", err)
	panic(http.ErrAbortHandler)
}
