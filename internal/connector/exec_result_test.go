package connector

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestExecResultMarshalsArraysNeverNull(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name   string
		result ExecResult
		want   []string
	}{
		{name: "failed statement", result: ExecResult{Statement: "CREATE TABLE t ()", Error: "already exists"}, want: []string{`"columns":[]`, `"rows":[]`}},
		{name: "skipped statement", result: ExecResult{Statement: "SELECT 1", Skipped: true}, want: []string{`"columns":[]`, `"rows":[]`, `"skipped":true`}},
		{name: "rows kept", result: ExecResult{Columns: []string{"id"}, Rows: [][]any{{1}}}, want: []string{`"columns":["id"]`, `"rows":[[1]]`}},
		{name: "session state", result: ExecResult{Transaction: TxOpen}, want: []string{`"transaction":"open"`}},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			for _, value := range []any{tc.result, &tc.result} {
				data, err := json.Marshal(value)
				if err != nil {
					t.Fatal(err)
				}
				for _, want := range tc.want {
					if !strings.Contains(string(data), want) {
						t.Fatalf("%s missing %s", data, want)
					}
				}
			}
		})
	}
}
