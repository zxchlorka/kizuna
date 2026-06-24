package redis

import (
	"context"
	"errors"
	"strconv"
	"testing"
	"time"

	"github.com/qsnake66/kizuna/internal/config"
	"github.com/qsnake66/kizuna/internal/connector"
)

func makeTestKeys(prefix string, count int) []string {
	keys := make([]string, 0, count)
	for i := 0; i < count; i++ {
		keys = append(keys, prefix+":"+strconv.Itoa(i))
	}
	return keys
}

func TestRedisCursorRoundTrip(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name    string
		token   string
		parse   func(string) error
		wantErr bool
	}{
		{name: "empty single cursor", token: "", parse: func(token string) error {
			cursor, err := parseSingleCursor(token)
			if err == nil && cursor != 0 {
				return errors.New("expected zero cursor")
			}
			return err
		}},
		{name: "single round trip", token: encodeSingleCursor(42), parse: func(token string) error {
			cursor, err := parseSingleCursor(token)
			if err == nil && cursor != 42 {
				return errors.New("expected cursor 42")
			}
			return err
		}},
		{name: "single rejects cluster token", token: "c:42:node:7000", parse: func(token string) error {
			_, err := parseSingleCursor(token)
			return err
		}, wantErr: true},
		{name: "single rejects garbage", token: "garbage", parse: func(token string) error {
			_, err := parseSingleCursor(token)
			return err
		}, wantErr: true},
		{name: "cluster round trip keeps addr with colons", token: encodeClusterCursor("node-b:7001", 7), parse: func(token string) error {
			addr, cursor, err := parseClusterCursor(token)
			if err == nil && (addr != "node-b:7001" || cursor != 7) {
				return errors.New("unexpected cluster cursor parts")
			}
			return err
		}},
		{name: "cluster rejects single token", token: "s:42", parse: func(token string) error {
			_, _, err := parseClusterCursor(token)
			return err
		}, wantErr: true},
		{name: "cluster rejects missing addr", token: "c:42:", parse: func(token string) error {
			_, _, err := parseClusterCursor(token)
			return err
		}, wantErr: true},
	}

	for _, tc := range tests {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			err := tc.parse(tc.token)
			if tc.wantErr {
				if !errors.Is(err, connector.ErrBadRequest) {
					t.Fatalf("expected bad request error, got %v", err)
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
		})
	}
}

func TestRedisListObjectsPageStandaloneKeyBudget(t *testing.T) {
	t.Parallel()

	conn := newRedisConnector(&fakeRedisClient{
		scanClient: &fakeScanClient{
			scanPages: map[string][][]string{
				"*": {makeTestKeys("ns", 1200), makeTestKeys("more", 100)},
			},
		},
	}, nil, config.ConnectionConfig{}, redisSettings{
		mode:      config.RedisModeStandalone,
		separator: ":",
	})

	first, err := conn.ListObjectsPage(context.Background(), connector.ObjectPageOpts{})
	if err != nil {
		t.Fatalf("first page: %v", err)
	}
	if first.NextCursor == "" {
		t.Fatalf("expected a continuation cursor after hitting the key budget")
	}
	if !first.Truncated {
		t.Fatalf("expected first page to be marked truncated")
	}
	if len(first.Objects) != 1 || first.Objects[0].Name != "ns" || first.Objects[0].RowCount != 1200 {
		t.Fatalf("unexpected first page objects: %#v", first.Objects)
	}

	second, err := conn.ListObjectsPage(context.Background(), connector.ObjectPageOpts{Cursor: first.NextCursor})
	if err != nil {
		t.Fatalf("second page: %v", err)
	}
	if second.NextCursor != "" {
		t.Fatalf("expected scan to finish on second page, got cursor %q", second.NextCursor)
	}
	if len(second.Objects) != 1 || second.Objects[0].Name != "more" || second.Objects[0].RowCount != 100 {
		t.Fatalf("unexpected second page objects: %#v", second.Objects)
	}
}

func TestRedisListObjectsPageScanIterationBudget(t *testing.T) {
	t.Parallel()

	pages := make([][]string, 0, pageMaxScans+5)
	for i := 0; i < pageMaxScans+5; i++ {
		pages = append(pages, []string{"k:" + strconv.Itoa(i)})
	}

	conn := newRedisConnector(&fakeRedisClient{
		scanClient: &fakeScanClient{scanPages: map[string][][]string{"*": pages}},
	}, nil, config.ConnectionConfig{}, redisSettings{
		mode:      config.RedisModeStandalone,
		separator: ":",
	})

	page, err := conn.ListObjectsPage(context.Background(), connector.ObjectPageOpts{})
	if err != nil {
		t.Fatalf("list objects page: %v", err)
	}
	if page.NextCursor != encodeSingleCursor(pageMaxScans) {
		t.Fatalf("expected cursor after %d scans, got %q", pageMaxScans, page.NextCursor)
	}
}

func TestRedisListObjectsPageClusterResumesOnNextNode(t *testing.T) {
	t.Parallel()

	topology := &fakeClusterTopology{
		masters: []string{"node-a:7000", "node-b:7001"},
		clients: map[string]redisScanClient{
			"node-a:7000": &fakeScanClient{scanPages: map[string][][]string{"*": {makeTestKeys("a", 1000)}}},
			"node-b:7001": &fakeScanClient{scanPages: map[string][][]string{"*": {makeTestKeys("b", 10)}}},
		},
	}

	conn := newRedisConnector(&fakeRedisClient{}, topology, config.ConnectionConfig{}, redisSettings{
		mode:      config.RedisModeCluster,
		separator: ":",
	})

	first, err := conn.ListObjectsPage(context.Background(), connector.ObjectPageOpts{})
	if err != nil {
		t.Fatalf("first page: %v", err)
	}
	if first.NextCursor != encodeClusterCursor("node-b:7001", 0) {
		t.Fatalf("expected cursor pointing at node-b, got %q", first.NextCursor)
	}
	if len(first.Objects) != 1 || first.Objects[0].Name != "a" {
		t.Fatalf("unexpected first page objects: %#v", first.Objects)
	}

	second, err := conn.ListObjectsPage(context.Background(), connector.ObjectPageOpts{Cursor: first.NextCursor})
	if err != nil {
		t.Fatalf("second page: %v", err)
	}
	if second.NextCursor != "" {
		t.Fatalf("expected scan to finish, got cursor %q", second.NextCursor)
	}
	if len(second.Objects) != 1 || second.Objects[0].Name != "b" || second.Objects[0].RowCount != 10 {
		t.Fatalf("unexpected second page objects: %#v", second.Objects)
	}
}

func TestRedisListObjectsPageNodePinned(t *testing.T) {
	t.Parallel()

	topology := &fakeClusterTopology{
		masters: []string{"node-a:7000", "node-b:7001"},
		clients: map[string]redisScanClient{
			"node-a:7000": &fakeScanClient{scanPages: map[string][][]string{"*": {{"a:1"}}}},
			"node-b:7001": &fakeScanClient{scanPages: map[string][][]string{"*": {{"b:1", "b:2"}}}},
		},
	}

	conn := newRedisConnector(&fakeRedisClient{}, topology, config.ConnectionConfig{}, redisSettings{
		mode:      config.RedisModeCluster,
		separator: ":",
	})

	page, err := conn.ListObjectsPage(context.Background(), connector.ObjectPageOpts{Node: "node-b:7001"})
	if err != nil {
		t.Fatalf("node-pinned page: %v", err)
	}
	if len(page.Objects) != 1 || page.Objects[0].Name != "b" || page.Objects[0].RowCount != 2 {
		t.Fatalf("unexpected node-pinned objects: %#v", page.Objects)
	}

	if _, err := conn.ListObjectsPage(context.Background(), connector.ObjectPageOpts{Node: "evil-host:6379"}); !errors.Is(err, connector.ErrBadRequest) {
		t.Fatalf("expected bad request for unknown node, got %v", err)
	}
}

func TestRedisListObjectsPageLeafDescribeUsesPipeline(t *testing.T) {
	t.Parallel()

	conn := newRedisConnector(&fakeRedisClient{
		typeValue: "hash",
		ttlValue:  90 * time.Second,
		scanClient: &fakeScanClient{
			scanPages: map[string][][]string{
				"*": {{"plain-key"}},
			},
		},
	}, nil, config.ConnectionConfig{}, redisSettings{
		mode:      config.RedisModeStandalone,
		separator: ":",
	})

	page, err := conn.ListObjectsPage(context.Background(), connector.ObjectPageOpts{})
	if err != nil {
		t.Fatalf("list objects page: %v", err)
	}
	if len(page.Objects) != 1 {
		t.Fatalf("expected one leaf object, got %#v", page.Objects)
	}
	leaf := page.Objects[0]
	if leaf.Type != "redis_hash" {
		t.Fatalf("unexpected leaf type: %q", leaf.Type)
	}
	if leaf.TTLSeconds == nil || *leaf.TTLSeconds != 90 {
		t.Fatalf("unexpected leaf ttl: %#v", leaf.TTLSeconds)
	}
}
