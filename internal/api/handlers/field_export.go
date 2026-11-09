package handlers

import (
	"context"
	"encoding/csv"
	"encoding/json"
	"errors"
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
	// The page names the export so its progress row exists before the request
	// lands; a script calling the endpoint directly gets one made up.
	exportID := q.Get("export_id")
	if exportID == "" {
		exportID = newExportID()
	} else if !exportIDPattern.MatchString(exportID) {
		writeError(w, http.StatusBadRequest, "export_id must be 1-64 letters, digits or dashes")
		return
	}
	var fields []string
	fieldsErr := json.Unmarshal([]byte(q.Get("fields")), &fields)

	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()
	job, err := h.exports.start(exportID, id, object, fields, cancel)
	if err != nil {
		writeError(w, http.StatusConflict, err.Error())
		return
	}
	// Registered first so that a request refused below still shows up in the
	// panel with its reason: the browser only says "Failed".
	refuse := func(status int, msg string) {
		h.exports.finish(job, errors.New(msg), false)
		writeError(w, status, msg)
	}

	if fieldsErr != nil || len(fields) == 0 {
		refuse(http.StatusBadRequest, "fields must be a non-empty JSON array of field paths")
		return
	}
	var filters []connector.FilterExpr
	if raw := q.Get("filters"); raw != "" {
		if err := json.Unmarshal([]byte(raw), &filters); err != nil {
			refuse(http.StatusBadRequest, "invalid filters JSON: "+err.Error())
			return
		}
	}

	conn, release, err := getConnector(ctx, h.manager, id)
	if err != nil {
		h.exports.finish(job, err, false)
		writeConnectorError(w, err)
		return
	}
	defer release()

	exporter, ok := conn.(connector.KafkaFieldExporter)
	if !ok {
		refuse(http.StatusBadRequest, "this source cannot export fields")
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

	// A failed write means the browser stopped reading, which is not the
	// broker's fault and should not read as a failure.
	writeFailed := false
	write := func(cells []string) error {
		if !started {
			if err := start(); err != nil {
				writeFailed = true
				return err
			}
		}
		if err := out.Write(cells); err != nil {
			writeFailed = true
			return err
		}
		return nil
	}
	err = exporter.ExportFields(ctx, object, fields, filters, func(cells []string) error {
		if err := write(cells); err != nil {
			return err
		}
		if job.rows.Add(1)%fieldExportFlushRows == 0 {
			out.Flush()
			if err := out.Error(); err != nil {
				writeFailed = true
				return err
			}
		}
		return nil
	}, func(read, total int64) {
		job.read.Store(read)
		job.total.Store(total)
	})
	if err == nil && !started {
		err = start()
		writeFailed = err != nil
	}
	if err == nil {
		out.Flush()
		err = out.Error()
		writeFailed = err != nil
	}
	status := h.exports.finish(job, err, writeFailed || r.Context().Err() != nil)
	if err == nil {
		return
	}
	if !started {
		writeConnectorError(w, err)
		return
	}
	level := slog.LevelInfo
	if status == exportFailed {
		level = slog.LevelError
	}
	slog.Log(r.Context(), level, "field export stopped", "status", status, "connection", id, "topic", object, "rows", job.rows.Load(), "error", err)
	panic(http.ErrAbortHandler)
}
