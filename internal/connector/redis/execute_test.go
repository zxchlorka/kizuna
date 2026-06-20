package redis

import (
	"context"
	"encoding/json"
	"errors"
	"testing"

	"github.com/qsnake66/infraview/internal/config"
	"github.com/qsnake66/infraview/internal/connector"
	goredis "github.com/redis/go-redis/v9"
)

func newTestRedisConnectorWithClient(client redisClient) *RedisConnector {
	return newRedisConnector(client, nil, config.ConnectionConfig{}, redisSettings{
		mode:      config.RedisModeStandalone,
		separator: ":",
	})
}

func TestParseRedisCommandQuoted(t *testing.T) {
	t.Parallel()

	args, err := parseRedisCommand(`SET greeting "hello world"`)
	if err != nil {
		t.Fatalf("parse redis command: %v", err)
	}
	if len(args) != 3 {
		t.Fatalf("unexpected token count: %d", len(args))
	}
	if args[2] != "hello world" {
		t.Fatalf("unexpected quoted token: %q", args[2])
	}
}

func TestExecuteFormatsHashPairs(t *testing.T) {
	t.Parallel()

	conn := newTestRedisConnectorWithClient(&fakeRedisClient{
		doResult: []any{"name", "alice", "role", "admin"},
	})

	result, err := conn.Execute(context.Background(), "HGETALL user:1")
	if err != nil {
		t.Fatalf("execute: %v", err)
	}
	if got, want := result.Columns[0], "field"; got != want {
		t.Fatalf("unexpected first column: got %q want %q", got, want)
	}
	if len(result.Rows) != 2 {
		t.Fatalf("unexpected row count: %d", len(result.Rows))
	}
}

func TestExecuteFormatsRESP3Map(t *testing.T) {
	t.Parallel()

	// go-redis v9 returns RESP3 map replies as map[any]any; the result must be
	// formatted as field/value rows and stay JSON-encodable.
	conn := newTestRedisConnectorWithClient(&fakeRedisClient{
		doResult: map[any]any{"name": "alice", "role": "admin", "age": int64(30)},
	})

	result, err := conn.Execute(context.Background(), "HGETALL user:1")
	if err != nil {
		t.Fatalf("execute: %v", err)
	}
	if result.Columns[0] != "field" {
		t.Fatalf("unexpected first column: %q", result.Columns[0])
	}
	if len(result.Rows) != 3 {
		t.Fatalf("unexpected row count: %d", len(result.Rows))
	}
	if result.Rows[0][0] != "age" {
		t.Fatalf("rows should be sorted by field; got first %v", result.Rows[0][0])
	}
	if _, err := json.Marshal(result); err != nil {
		t.Fatalf("result must be JSON-encodable: %v", err)
	}
}

func TestExecuteFormatsSortedSetWithScores(t *testing.T) {
	t.Parallel()

	conn := newTestRedisConnectorWithClient(&fakeRedisClient{
		doResult: []any{"alice", "1", "bob", "2.5"},
	})

	result, err := conn.Execute(context.Background(), "ZRANGE z 0 -1 WITHSCORES")
	if err != nil {
		t.Fatalf("execute: %v", err)
	}
	if len(result.Columns) != 2 || result.Columns[0] != "member" || result.Columns[1] != "score" {
		t.Fatalf("unexpected columns: %#v", result.Columns)
	}
	if len(result.Rows) != 2 {
		t.Fatalf("unexpected row count: %d", len(result.Rows))
	}
	if result.Rows[0][0] != "alice" || result.Rows[0][1] != float64(1) {
		t.Fatalf("unexpected first row: %#v", result.Rows[0])
	}
	if result.Rows[1][1] != 2.5 {
		t.Fatalf("expected float score, got %#v (%T)", result.Rows[1][1], result.Rows[1][1])
	}
}

func TestExecuteFormatsSortedSetNestedScores(t *testing.T) {
	t.Parallel()

	// RESP3 can deliver WITHSCORES/ZPOP replies as nested [member, score] arrays.
	conn := newTestRedisConnectorWithClient(&fakeRedisClient{
		doResult: []any{[]any{"alice", "1"}, []any{"bob", "2.5"}},
	})

	result, err := conn.Execute(context.Background(), "ZPOPMIN z 2")
	if err != nil {
		t.Fatalf("execute: %v", err)
	}
	if result.Columns[0] != "member" || result.Columns[1] != "score" {
		t.Fatalf("unexpected columns: %#v", result.Columns)
	}
	if len(result.Rows) != 2 || result.Rows[1][0] != "bob" || result.Rows[1][1] != 2.5 {
		t.Fatalf("unexpected rows: %#v", result.Rows)
	}
}

func TestExecuteSortedSetWithoutScoresStaysIndexed(t *testing.T) {
	t.Parallel()

	conn := newTestRedisConnectorWithClient(&fakeRedisClient{
		doResult: []any{"alice", "bob"},
	})

	result, err := conn.Execute(context.Background(), "ZRANGEBYLEX z - +")
	if err != nil {
		t.Fatalf("execute: %v", err)
	}
	if result.Columns[0] != "index" {
		t.Fatalf("expected index/value for a non-scored zset read, got %#v", result.Columns)
	}
}

func TestJSONSafeValueHandlesNestedRESP3(t *testing.T) {
	t.Parallel()

	safe := jsonSafeValue(map[any]any{
		"nested": map[any]any{"k": []any{[]byte("v"), int64(1)}},
	})
	if _, err := json.Marshal(safe); err != nil {
		t.Fatalf("nested RESP3 value must be JSON-encodable: %v", err)
	}
}

func TestExecuteBatchUsesPipelineResults(t *testing.T) {
	t.Parallel()

	conn := newTestRedisConnectorWithClient(&fakeRedisClient{
		pipelineCmders: []goredis.Cmder{
			goredis.NewCmdResult("OK", nil),
			goredis.NewCmdResult([]any{"field", "value"}, nil),
		},
	})

	results, err := conn.ExecuteBatch(context.Background(), []string{"SET a 1", "HGETALL h"})
	if err != nil {
		t.Fatalf("execute batch: %v", err)
	}
	if len(results) != 2 {
		t.Fatalf("unexpected batch length: %d", len(results))
	}
	if results[1].Columns[0] != "field" {
		t.Fatalf("expected hash-style formatting, got %#v", results[1].Columns)
	}
}

func TestRedisCompletionsSupportsCommandsAndKeys(t *testing.T) {
	t.Parallel()

	fakeClient := &fakeRedisClient{
		scanClient: &fakeScanClient{
			scanPages: map[string][][]string{
				"user*": {{"user:1", "user:2"}},
			},
		},
	}
	conn := newTestRedisConnectorWithClient(fakeClient)

	commandItems, err := conn.Completions(context.Background(), connector.CompletionRequest{Prefix: "HG", Context: "command"})
	if err != nil {
		t.Fatalf("command completions: %v", err)
	}
	if len(commandItems) == 0 || commandItems[0].Type != "command" {
		t.Fatalf("expected command completions, got %#v", commandItems)
	}

	keyItems, err := conn.Completions(context.Background(), connector.CompletionRequest{Prefix: "user", Context: "key"})
	if err != nil {
		t.Fatalf("key completions: %v", err)
	}
	if len(keyItems) != 2 {
		t.Fatalf("unexpected key completion count: %d", len(keyItems))
	}
}

func TestGetDataSupportsRedisJSON(t *testing.T) {
	t.Parallel()

	conn := newTestRedisConnectorWithClient(&fakeRedisClient{
		typeValue: "ReJSON-RL",
		doResult:  `[{"user":{"name":"alice","active":true}}]`,
	})

	result, err := conn.GetData(context.Background(), "profile:1", connector.DataOpts{})
	if err != nil {
		t.Fatalf("get json data: %v", err)
	}
	if got, want := result.Columns[0].Name, "path"; got != want {
		t.Fatalf("unexpected first column: got %q want %q", got, want)
	}
	foundLeaf := false
	for _, row := range result.Rows {
		if row["path"] == "$.user.name" && row["value"] == "alice" {
			foundLeaf = true
			break
		}
	}
	if !foundLeaf {
		t.Fatalf("expected flattened leaf row, got %#v", result.Rows)
	}
}

func TestGetDataUsesBracketPathsForSpecialJSONKeys(t *testing.T) {
	t.Parallel()

	conn := newTestRedisConnectorWithClient(&fakeRedisClient{
		typeValue: "json",
		doResult:  `[{"mountain bikes":{"wheel.size":29}}]`,
	})

	result, err := conn.GetData(context.Background(), "bikes:1", connector.DataOpts{})
	if err != nil {
		t.Fatalf("get json data: %v", err)
	}

	foundLeaf := false
	for _, row := range result.Rows {
		if row["path"] == `$["mountain bikes"]["wheel.size"]` && row["value"] == float64(29) {
			foundLeaf = true
			break
		}
	}
	if !foundLeaf {
		t.Fatalf("expected bracket-escaped path, got %#v", result.Rows)
	}
}

func TestGetDataSupportsStreamCursorPaging(t *testing.T) {
	t.Parallel()

	conn := newTestRedisConnectorWithClient(&fakeRedisClient{
		typeValue: "stream",
		xRevRangeMessages: []goredis.XMessage{
			{ID: "2-0", Values: map[string]any{"kind": "new"}},
			{ID: "1-0", Values: map[string]any{"kind": "old"}},
		},
		xInfoGroups: []goredis.XInfoGroup{{Name: "workers"}},
	})

	result, err := conn.GetData(context.Background(), "events", connector.DataOpts{Limit: 2})
	if err != nil {
		t.Fatalf("get stream data: %v", err)
	}
	if result.Meta["first_id"] != "1-0" || result.Meta["last_id"] != "2-0" {
		t.Fatalf("unexpected stream cursors: %#v", result.Meta)
	}
	if result.Meta["consumer_groups"] != 1 {
		t.Fatalf("unexpected consumer group count: %#v", result.Meta)
	}
}

func TestGetDataStreamCursorBoundaryFlags(t *testing.T) {
	t.Parallel()

	conn := newTestRedisConnectorWithClient(&fakeRedisClient{
		typeValue: "stream",
		xRangeMessages: []goredis.XMessage{
			{ID: "3-0", Values: map[string]any{"kind": "newer"}},
			{ID: "4-0", Values: map[string]any{"kind": "latest"}},
		},
		xRevRangeMessages: []goredis.XMessage{
			{ID: "2-0", Values: map[string]any{"kind": "mid"}},
			{ID: "1-0", Values: map[string]any{"kind": "old"}},
		},
	})

	afterPage, err := conn.GetData(context.Background(), "events", connector.DataOpts{
		Limit: 2,
		Filters: []connector.FilterExpr{
			{Column: "after_id", Value: "2-0"},
		},
	})
	if err != nil {
		t.Fatalf("get newer stream page: %v", err)
	}
	if afterPage.Meta["has_newer"] != false {
		t.Fatalf("expected no newer page, got %#v", afterPage.Meta)
	}
	if afterPage.Meta["has_older"] != true {
		t.Fatalf("expected older page toggle, got %#v", afterPage.Meta)
	}

	beforePage, err := conn.GetData(context.Background(), "events", connector.DataOpts{
		Limit: 2,
		Filters: []connector.FilterExpr{
			{Column: "before_id", Value: "3-0"},
		},
	})
	if err != nil {
		t.Fatalf("get older stream page: %v", err)
	}
	if beforePage.Meta["has_older"] != false {
		t.Fatalf("expected no older page, got %#v", beforePage.Meta)
	}
	if beforePage.Meta["has_newer"] != true {
		t.Fatalf("expected newer page toggle, got %#v", beforePage.Meta)
	}
}

func TestMutateBulkPreviewAndSafety(t *testing.T) {
	t.Parallel()

	conn := newTestRedisConnectorWithClient(&fakeRedisClient{
		scanClient: &fakeScanClient{
			scanPages: map[string][][]string{
				"cache:*": {{"cache:a", "cache:b"}},
			},
		},
	})

	_, err := conn.MutateBulk(context.Background(), connector.BulkMutateOp{
		Pattern: "*",
		Preview: true,
	})
	if !errors.Is(err, connector.ErrBadRequest) {
		t.Fatalf("expected bad request for global delete safeguard, got %v", err)
	}

	result, err := conn.MutateBulk(context.Background(), connector.BulkMutateOp{
		Pattern: "cache:*",
		Preview: true,
	})
	if err != nil {
		t.Fatalf("bulk preview: %v", err)
	}
	if result.Applied != 2 {
		t.Fatalf("unexpected preview count: %d", result.Applied)
	}
}
