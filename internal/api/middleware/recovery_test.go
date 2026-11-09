package middleware

import (
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
)

// A handler that has already streamed part of a body aborts with
// http.ErrAbortHandler so the client sees a broken download. Recovery must let
// that through: answering it with a JSON error appends to the half-sent body and
// ends the response cleanly, which turns a failed download into a complete-looking
// file.
func TestRecoveryLetsAbortHandlerThrough(t *testing.T) {
	server := httptest.NewServer(Recovery(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = io.WriteString(w, "user_id\n1\n")
		w.(http.Flusher).Flush()
		panic(http.ErrAbortHandler)
	})))
	defer server.Close()

	resp, err := http.Get(server.URL)
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	defer resp.Body.Close()
	if _, err := io.ReadAll(resp.Body); err == nil {
		t.Fatal("body read completed; the aborted response must fail on the client")
	}
}
