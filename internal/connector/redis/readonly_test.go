package redis

import (
	"context"
	"errors"
	"testing"

	"github.com/zxchlorka/kizuna/internal/config"
	"github.com/zxchlorka/kizuna/internal/connector"
)

func TestIsRedisReadOnlyCommand(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name string
		want bool
	}{
		{name: "GET", want: true},
		{name: "get", want: true},
		{name: "SCAN", want: true},
		{name: "HGETALL", want: true},
		{name: "TYPE", want: true},
		{name: "JSON.GET", want: true},
		{name: "SET", want: false},
		{name: "DEL", want: false},
		{name: "FLUSHALL", want: false},
		{name: "GETEX", want: false},  // mutates TTL
		{name: "GETDEL", want: false}, // deletes
		{name: "SORT", want: false},   // SORT ... STORE writes
		{name: "CONFIG", want: false},
		{name: "TOTALLY_UNKNOWN", want: false},
	}

	for _, tc := range tests {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			if got := isRedisReadOnlyCommand(tc.name); got != tc.want {
				t.Fatalf("isRedisReadOnlyCommand(%q) = %v, want %v", tc.name, got, tc.want)
			}
		})
	}
}

func newReadOnlyRedisConnector(client redisClient) *RedisConnector {
	return newRedisConnector(client, nil, config.ConnectionConfig{ReadOnly: true}, redisSettings{
		mode:      config.RedisModeStandalone,
		separator: ":",
	})
}

func TestReadOnlyBlocksMutate(t *testing.T) {
	t.Parallel()

	conn := newReadOnlyRedisConnector(&fakeRedisClient{})
	_, err := conn.Mutate(context.Background(), connector.MutateOp{Object: "k", Type: "update", Data: map[string]any{"value": "v"}})
	if !errors.Is(err, connector.ErrReadOnly) {
		t.Fatalf("expected ErrReadOnly, got %v", err)
	}
}

func TestReadOnlyBlocksBulkDeleteButAllowsPreview(t *testing.T) {
	t.Parallel()

	conn := newReadOnlyRedisConnector(&fakeRedisClient{
		scanClient: &fakeScanClient{scanPages: map[string][][]string{"cache:*": {{"cache:1", "cache:2"}}}},
	})

	if _, err := conn.MutateBulk(context.Background(), connector.BulkMutateOp{Pattern: "cache:*", Execute: true}); !errors.Is(err, connector.ErrReadOnly) {
		t.Fatalf("expected ErrReadOnly for execute, got %v", err)
	}

	preview, err := conn.MutateBulk(context.Background(), connector.BulkMutateOp{Pattern: "cache:*", Preview: true})
	if err != nil {
		t.Fatalf("preview should be allowed on read-only: %v", err)
	}
	if preview.Applied != 2 {
		t.Fatalf("expected preview to match 2 keys, got %d", preview.Applied)
	}
}

func TestReadOnlyExecuteAllowsReadsBlocksWrites(t *testing.T) {
	t.Parallel()

	conn := newReadOnlyRedisConnector(&fakeRedisClient{doResult: "value"})

	if _, err := conn.Execute(context.Background(), "GET mykey"); err != nil {
		t.Fatalf("read command should be allowed: %v", err)
	}

	for _, command := range []string{"SET k v", "DEL k", "FLUSHALL", "GETEX k", "WONKYCMD k"} {
		if _, err := conn.Execute(context.Background(), command); !errors.Is(err, connector.ErrReadOnly) {
			t.Fatalf("expected ErrReadOnly for %q, got %v", command, err)
		}
	}
}

func TestReadOnlyExecuteBatchBlocksAnyWrite(t *testing.T) {
	t.Parallel()

	conn := newReadOnlyRedisConnector(&fakeRedisClient{})
	if _, err := conn.ExecuteBatch(context.Background(), []string{"GET a", "SET b c"}); !errors.Is(err, connector.ErrReadOnly) {
		t.Fatalf("expected ErrReadOnly when batch contains a write, got %v", err)
	}
}
