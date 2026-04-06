package postgres

import (
	"testing"
	"time"
)

func TestKeywordCompletionsPrefix(t *testing.T) {
	t.Parallel()

	items := keywordCompletions("sel")
	if len(items) == 0 {
		t.Fatalf("expected keyword completions for prefix")
	}
	if items[0].Label != "SELECT" {
		t.Fatalf("unexpected first keyword: %q", items[0].Label)
	}
}

func TestMatchesCompletionPrefix(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name   string
		label  string
		prefix string
		want   bool
	}{
		{name: "qualified schema match", label: "cch.allocation", prefix: "cch.", want: true},
		{name: "qualified bare table match", label: "cch.allocation", prefix: "alloc", want: true},
		{name: "public table match", label: "public.users", prefix: "users", want: true},
		{name: "mismatch", label: "reporting.daily_rollup", prefix: "users", want: false},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			if got := matchesCompletionPrefix(tc.label, tc.prefix); got != tc.want {
				t.Fatalf("matchesCompletionPrefix(%q, %q) = %v, want %v", tc.label, tc.prefix, got, tc.want)
			}
		})
	}
}

func TestInvalidateCompletionCache(t *testing.T) {
	t.Parallel()

	conn := &PostgresConnector{
		tableCache:      []completionCacheItem{{label: "users", detail: "BASE TABLE"}},
		tableCacheUntil: time.Now().Add(time.Minute),
		columnCache: map[string]completionCacheBucket{
			"users": {
				items:   []completionCacheItem{{label: "id", detail: "integer"}},
				expires: time.Now().Add(time.Minute),
			},
		},
	}

	conn.invalidateCompletionCache()

	if len(conn.tableCache) != 0 {
		t.Fatalf("expected empty table cache")
	}
	if !conn.tableCacheUntil.IsZero() {
		t.Fatalf("expected zero table cache expiry")
	}
	if len(conn.columnCache) != 0 {
		t.Fatalf("expected empty column cache")
	}
}
