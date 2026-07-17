package handlers

import (
	"errors"
	"net/http"
	"testing"

	"github.com/zxchlorka/kizuna/internal/connector"
)

func TestMapConnectorErrorStatuses(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name   string
		err    error
		status int
	}{
		{name: "bad request", err: connector.ErrBadRequest, status: http.StatusBadRequest},
		{name: "forbidden", err: connector.ErrForbidden, status: http.StatusForbidden},
		{name: "read only", err: connector.ErrReadOnly, status: http.StatusForbidden},
		{name: "relation not found", err: connector.ErrRelationNotFound, status: http.StatusNotFound},
		{name: "conflict", err: connector.ErrConflict, status: http.StatusConflict},
		{name: "timeout", err: connector.ErrTimeout, status: http.StatusRequestTimeout},
		{name: "unavailable", err: connector.ErrUnavailable, status: http.StatusServiceUnavailable},
		{name: "plain not found", err: errors.New("connection not found"), status: http.StatusNotFound},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			status, _ := mapConnectorError(tt.err)
			if status != tt.status {
				t.Fatalf("unexpected status: got %d want %d", status, tt.status)
			}
		})
	}
}

func TestMapConnectorErrorAddsRetryHint(t *testing.T) {
	t.Parallel()

	_, msg := mapConnectorError(connector.ErrUnavailable)
	if msg == connector.ErrUnavailable.Error() {
		t.Fatalf("expected retry hint in message, got %q", msg)
	}
}
