package handlers

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"
	"time"

	"github.com/zxchlorka/kizuna/internal/connector"
)

func TestExportRegistryLifecycle(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name       string
		finish     func(*exportRegistry, *exportJob)
		wantStatus exportStatus
		wantError  string
	}{
		{name: "finished cleanly", finish: func(r *exportRegistry, j *exportJob) { r.finish(j, nil, false) }, wantStatus: exportDone},
		{name: "broker failure", finish: func(r *exportRegistry, j *exportJob) { r.finish(j, errors.New("broker went away"), false) }, wantStatus: exportFailed, wantError: "broker went away"},
		{name: "browser went away", finish: func(r *exportRegistry, j *exportJob) { r.finish(j, context.Canceled, true) }, wantStatus: exportInterrupted},
		{name: "stopped from the panel", finish: func(r *exportRegistry, j *exportJob) {
			r.cancel(j.id)
			r.finish(j, context.Canceled, true)
		}, wantStatus: exportCancelled},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			registry := newExportRegistry()
			cancelled := false
			job, err := registry.start("job-1", "conn-1", "events", []string{"user_id"}, func() { cancelled = true })
			if err != nil {
				t.Fatalf("start: %v", err)
			}
			job.read.Store(40)
			job.total.Store(100)
			job.rows.Store(7)

			running := registry.list()
			if len(running) != 1 || running[0].Status != exportRunning || running[0].Read != 40 || running[0].Total != 100 || running[0].Rows != 7 {
				t.Fatalf("running snapshot %+v", running)
			}

			tt.finish(registry, job)
			got := registry.list()[0]
			if got.Status != tt.wantStatus || got.Error != tt.wantError || got.FinishedAt == nil {
				t.Fatalf("finished snapshot %+v, want status %q error %q", got, tt.wantStatus, tt.wantError)
			}
			if tt.wantStatus == exportCancelled && !cancelled {
				t.Fatal("cancel did not reach the export")
			}
		})
	}
}

func TestExportRegistryRejectsARunningDuplicate(t *testing.T) {
	t.Parallel()

	registry := newExportRegistry()
	job, err := registry.start("job-1", "conn-1", "events", nil, func() {})
	if err != nil {
		t.Fatalf("start: %v", err)
	}
	if _, err := registry.start("job-1", "conn-1", "events", nil, func() {}); err == nil {
		t.Fatal("a second running export under the same id was accepted")
	}
	registry.finish(job, nil, false)
	if _, err := registry.start("job-1", "conn-1", "events", nil, func() {}); err != nil {
		t.Fatalf("restart after finish: %v", err)
	}
	if n := len(registry.list()); n != 1 {
		t.Fatalf("%d jobs listed, want the restart to replace the finished one", n)
	}
}

func TestExportRegistryForgetsTheOldestFinished(t *testing.T) {
	t.Parallel()

	registry := newExportRegistry()
	running, _ := registry.start("running", "conn-1", "events", nil, func() {})
	for i := range maxRememberedExports + 5 {
		job, _ := registry.start(fmt.Sprintf("done-%d", i), "conn-1", "events", nil, func() {})
		registry.finish(job, nil, false)
	}
	jobs := registry.list()
	if len(jobs) != maxRememberedExports {
		t.Fatalf("%d jobs remembered, want %d", len(jobs), maxRememberedExports)
	}
	found := false
	for _, job := range jobs {
		if job.ID == running.id {
			found = true
		}
		if job.ID == "done-0" {
			t.Fatal("the oldest finished export was kept")
		}
	}
	if !found {
		t.Fatal("a running export was dropped to make room")
	}
}

func TestExportFieldsShowsUpInTheExportList(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name       string
		conn       *testFieldExporter
		wantStatus exportStatus
		wantRows   int64
		wantError  bool
	}{
		{name: "finished export", conn: &testFieldExporter{rows: [][]string{{"1"}, {"2"}}, total: 10}, wantStatus: exportDone, wantRows: 2},
		{name: "rejected before the first row", conn: &testFieldExporter{failBefore: fmt.Errorf("%w: topic gone", connector.ErrRelationNotFound)}, wantStatus: exportFailed, wantError: true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			handler := newFieldExportHandler(tt.conn)
			query := "export_id=job-7&fields=" + url.QueryEscape(`["user_id"]`)
			handler.ExportFields(httptest.NewRecorder(), fieldExportRequest("events", query))

			jobs := listExports(t, handler)
			if len(jobs) != 1 {
				t.Fatalf("%d jobs listed", len(jobs))
			}
			job := jobs[0]
			if job.ID != "job-7" || job.Topic != "events" || job.ConnectionID != "conn-1" || job.Status != tt.wantStatus || job.Rows != tt.wantRows {
				t.Fatalf("job %+v", job)
			}
			if tt.wantStatus == exportDone && (job.Read != 10 || job.Total != 10) {
				t.Fatalf("progress %d/%d, want 10/10", job.Read, job.Total)
			}
			if tt.wantError != (job.Error != "") {
				t.Fatalf("error %q", job.Error)
			}
		})
	}
}

func TestCancelExportStopsARunningDownload(t *testing.T) {
	t.Parallel()

	conn := &testFieldExporter{rows: [][]string{{"1"}}, total: 5, block: true, started: make(chan struct{})}
	handler := newFieldExportHandler(conn)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		handler.ExportFields(w, withRouteParams(r, map[string]string{"id": "conn-1", "name": "events"}))
	}))
	defer server.Close()

	done := make(chan struct{})
	go func() {
		defer close(done)
		resp, err := http.Get(server.URL + "/?export_id=job-9&fields=" + url.QueryEscape(`["user_id"]`))
		if err == nil {
			_, _ = io.ReadAll(resp.Body)
			resp.Body.Close()
		}
	}()
	select {
	case <-conn.started:
	case <-time.After(5 * time.Second):
		t.Fatal("export never started")
	}

	rec := httptest.NewRecorder()
	handler.CancelExport(rec, withRouteParams(httptest.NewRequest(http.MethodDelete, "/api/exports/job-9", nil), map[string]string{"exportID": "job-9"}))
	if rec.Code != http.StatusAccepted {
		t.Fatalf("cancel status %d", rec.Code)
	}
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("download kept running after cancel")
	}

	deadline := time.Now().Add(5 * time.Second)
	for {
		jobs := listExports(t, handler)
		if len(jobs) == 1 && jobs[0].Status == exportCancelled {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("jobs %+v, want job-9 cancelled", jobs)
		}
		time.Sleep(10 * time.Millisecond)
	}

	// A finished export is dismissed by the same call, and then it is gone.
	rec = httptest.NewRecorder()
	handler.CancelExport(rec, withRouteParams(httptest.NewRequest(http.MethodDelete, "/api/exports/job-9", nil), map[string]string{"exportID": "job-9"}))
	if rec.Code != http.StatusNoContent || len(listExports(t, handler)) != 0 {
		t.Fatalf("dismiss status %d, jobs %v", rec.Code, listExports(t, handler))
	}

	rec = httptest.NewRecorder()
	handler.CancelExport(rec, withRouteParams(httptest.NewRequest(http.MethodDelete, "/api/exports/nope", nil), map[string]string{"exportID": "nope"}))
	if rec.Code != http.StatusNotFound {
		t.Fatalf("unknown export status %d", rec.Code)
	}
}

func listExports(t *testing.T, handler *DataHandler) []exportSnapshot {
	t.Helper()
	rec := httptest.NewRecorder()
	handler.ListExports(rec, httptest.NewRequest(http.MethodGet, "/api/exports", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("list status %d", rec.Code)
	}
	var jobs []exportSnapshot
	if err := json.NewDecoder(rec.Body).Decode(&jobs); err != nil {
		t.Fatalf("decode: %v", err)
	}
	return jobs
}
