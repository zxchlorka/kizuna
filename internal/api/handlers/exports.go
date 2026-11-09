package handlers

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"net/http"
	"regexp"
	"slices"
	"sync"
	"sync/atomic"
	"time"

	"github.com/go-chi/chi/v5"
)

// maxRememberedExports caps how many exports the list keeps. Finished ones past
// it are forgotten oldest first; running ones are never dropped.
const maxRememberedExports = 50

type exportStatus string

const (
	exportRunning     exportStatus = "running"
	exportDone        exportStatus = "done"
	exportFailed      exportStatus = "failed"
	exportCancelled   exportStatus = "cancelled"
	exportInterrupted exportStatus = "interrupted"
)

var exportIDPattern = regexp.MustCompile(`^[A-Za-z0-9-]{1,64}$`)

// exportJob is one field export as the progress panel sees it. The counters
// move on every fetch and every row, so they are atomics; the rest changes at
// most twice and sits behind the registry's lock.
type exportJob struct {
	id           string
	connectionID string
	topic        string
	fields       []string
	startedAt    time.Time

	read  atomic.Int64
	total atomic.Int64
	rows  atomic.Int64

	status          exportStatus
	err             string
	finishedAt      *time.Time
	cancel          context.CancelFunc
	cancelledByUser bool
}

type exportSnapshot struct {
	ID           string       `json:"id"`
	ConnectionID string       `json:"connection_id"`
	Topic        string       `json:"topic"`
	Fields       []string     `json:"fields"`
	Status       exportStatus `json:"status"`
	Read         int64        `json:"read"`
	Total        int64        `json:"total"`
	Rows         int64        `json:"rows"`
	StartedAt    time.Time    `json:"started_at"`
	FinishedAt   *time.Time   `json:"finished_at,omitempty"`
	Error        string       `json:"error,omitempty"`
}

// exportRegistry is the in-memory list behind GET /api/exports. A download's
// bytes go straight to the browser's download manager, which the page cannot
// look into, so this is the only place the page can learn how far along an
// export is. It does not survive a restart, and neither does the export.
type exportRegistry struct {
	mu   sync.Mutex
	jobs []*exportJob // oldest first
}

func newExportRegistry() *exportRegistry {
	return &exportRegistry{}
}

func (r *exportRegistry) start(id, connectionID, topic string, fields []string, cancel context.CancelFunc) (*exportJob, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if at := r.indexOf(id); at >= 0 {
		if r.jobs[at].status == exportRunning {
			return nil, errors.New("an export with this id is already running")
		}
		r.jobs = slices.Delete(r.jobs, at, at+1)
	}
	job := &exportJob{
		id:           id,
		connectionID: connectionID,
		topic:        topic,
		fields:       fields,
		startedAt:    time.Now(),
		status:       exportRunning,
		cancel:       cancel,
	}
	r.jobs = append(r.jobs, job)
	for len(r.jobs) > maxRememberedExports {
		at := slices.IndexFunc(r.jobs, func(j *exportJob) bool { return j.status != exportRunning })
		if at < 0 {
			break
		}
		r.jobs = slices.Delete(r.jobs, at, at+1)
	}
	return job, nil
}

// finish records how an export ended and returns that status. clientGone means
// the browser stopped reading: the download was closed, the machine slept, the
// connection dropped.
func (r *exportRegistry) finish(job *exportJob, err error, clientGone bool) exportStatus {
	r.mu.Lock()
	defer r.mu.Unlock()
	now := time.Now()
	job.finishedAt = &now
	switch {
	case err == nil:
		job.status = exportDone
	case job.cancelledByUser:
		job.status = exportCancelled
	case clientGone:
		job.status = exportInterrupted
	default:
		job.status = exportFailed
		_, job.err = mapConnectorError(err)
	}
	return job.status
}

// cancel stops a running export, or forgets a finished one. found is false for
// an id the registry does not know.
func (r *exportRegistry) cancel(id string) (found, wasRunning bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	at := r.indexOf(id)
	if at < 0 {
		return false, false
	}
	job := r.jobs[at]
	if job.status == exportRunning {
		job.cancelledByUser = true
		job.cancel()
		return true, true
	}
	r.jobs = slices.Delete(r.jobs, at, at+1)
	return true, false
}

// list returns every export, newest first.
func (r *exportRegistry) list() []exportSnapshot {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := make([]exportSnapshot, 0, len(r.jobs))
	for i := len(r.jobs) - 1; i >= 0; i-- {
		job := r.jobs[i]
		out = append(out, exportSnapshot{
			ID:           job.id,
			ConnectionID: job.connectionID,
			Topic:        job.topic,
			Fields:       job.fields,
			Status:       job.status,
			Read:         job.read.Load(),
			Total:        job.total.Load(),
			Rows:         job.rows.Load(),
			StartedAt:    job.startedAt,
			FinishedAt:   job.finishedAt,
			Error:        job.err,
		})
	}
	return out
}

func (r *exportRegistry) indexOf(id string) int {
	return slices.IndexFunc(r.jobs, func(j *exportJob) bool { return j.id == id })
}

func newExportID() string {
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

// ListExports serves GET /api/exports for the progress panel.
func (h *DataHandler) ListExports(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, h.exports.list())
}

// CancelExport serves DELETE /api/exports/{exportID}: it stops a running export
// (its download then fails in the browser) or dismisses a finished one.
func (h *DataHandler) CancelExport(w http.ResponseWriter, r *http.Request) {
	found, wasRunning := h.exports.cancel(chi.URLParam(r, "exportID"))
	switch {
	case !found:
		writeError(w, http.StatusNotFound, "export not found")
	case wasRunning:
		w.WriteHeader(http.StatusAccepted)
	default:
		w.WriteHeader(http.StatusNoContent)
	}
}
