package connector

import (
	"context"
	"errors"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/qsnake66/infraview/internal/config"
)

type testManagerConnector struct {
	pingCount int
}

func (c *testManagerConnector) Ping(context.Context) error {
	c.pingCount++
	return nil
}
func (c *testManagerConnector) GetInfo(context.Context) (*ConnInfo, error) { return nil, nil }
func (c *testManagerConnector) ListObjects(context.Context, string) ([]Object, error) {
	return nil, nil
}
func (c *testManagerConnector) GetObjectInfo(context.Context, string) (*ObjectInfo, error) {
	return nil, nil
}
func (c *testManagerConnector) GetSchema(context.Context, string) (*Schema, error) { return nil, nil }
func (c *testManagerConnector) GetData(context.Context, string, DataOpts) (*DataResult, error) {
	return nil, nil
}
func (c *testManagerConnector) Execute(context.Context, string) (*ExecResult, error) { return nil, nil }
func (c *testManagerConnector) ExecuteBatch(context.Context, []string) ([]ExecResult, error) {
	return nil, nil
}
func (c *testManagerConnector) Explain(context.Context, string) (*ExplainResult, error) {
	return nil, nil
}
func (c *testManagerConnector) Analyze(context.Context, string) (*ExplainResult, error) {
	return nil, nil
}
func (c *testManagerConnector) Completions(context.Context, CompletionRequest) ([]CompletionItem, error) {
	return nil, nil
}
func (c *testManagerConnector) Mutate(context.Context, MutateOp) (*MutateResult, error) {
	return nil, nil
}
func (c *testManagerConnector) MutateBulk(context.Context, BulkMutateOp) (*BulkMutateResult, error) {
	return nil, nil
}
func (c *testManagerConnector) DDL(context.Context, DDLOp) error { return nil }
func (c *testManagerConnector) Close() error                     { return nil }

func TestConnectionManagerSupportsRedisFactory(t *testing.T) {
	t.Parallel()

	cfg := &config.AppConfig{
		Connections: []config.ConnectionConfig{
			{
				ID:   "redis-1",
				Type: "redis",
			},
		},
		EncryptionKey: "test-key",
	}

	manager := NewConnectionManager(cfg)
	redisConn := &testManagerConnector{}
	manager.RegisterFactory("redis", func(context.Context, config.ConnectionConfig, string) (Connector, error) {
		return redisConn, nil
	})

	got, err := manager.Get(context.Background(), "redis-1")
	if err != nil {
		t.Fatalf("manager get: %v", err)
	}
	if got != redisConn {
		t.Fatalf("unexpected connector returned")
	}
}

func TestConnectionManagerSkipsRepeatedValidationWithinTTL(t *testing.T) {
	t.Parallel()

	cfg := &config.AppConfig{
		Connections: []config.ConnectionConfig{
			{
				ID:   "pg-1",
				Type: "postgres",
			},
		},
		EncryptionKey: "test-key",
	}

	manager := NewConnectionManager(cfg)
	pgConn := &testManagerConnector{}
	manager.RegisterFactory("postgres", func(context.Context, config.ConnectionConfig, string) (Connector, error) {
		return pgConn, nil
	})

	if _, err := manager.Get(context.Background(), "pg-1"); err != nil {
		t.Fatalf("first get: %v", err)
	}
	if _, err := manager.Get(context.Background(), "pg-1"); err != nil {
		t.Fatalf("second get: %v", err)
	}

	if pgConn.pingCount != 0 {
		t.Fatalf("expected cached connector get to skip extra ping within ttl, got %d", pgConn.pingCount)
	}
}

func TestConnectionManagerDeduplicatesConcurrentCreateForSameConnection(t *testing.T) {
	t.Parallel()

	cfg := &config.AppConfig{
		Connections: []config.ConnectionConfig{
			{ID: "pg-1", Type: "postgres"},
		},
		EncryptionKey: "test-key",
	}

	manager := NewConnectionManager(cfg)
	conn := &testManagerConnector{}
	var calls atomic.Int32
	manager.RegisterFactory("postgres", func(context.Context, config.ConnectionConfig, string) (Connector, error) {
		calls.Add(1)
		time.Sleep(20 * time.Millisecond)
		return conn, nil
	})

	const workers = 12
	results := make(chan Connector, workers)
	errs := make(chan error, workers)
	var wg sync.WaitGroup
	for range workers {
		wg.Add(1)
		go func() {
			defer wg.Done()
			got, err := manager.Get(context.Background(), "pg-1")
			if err != nil {
				errs <- err
				return
			}
			results <- got
		}()
	}
	wg.Wait()
	close(results)
	close(errs)

	for err := range errs {
		t.Fatalf("get failed: %v", err)
	}
	for got := range results {
		if got != conn {
			t.Fatalf("unexpected connector returned")
		}
	}
	if got := calls.Load(); got != 1 {
		t.Fatalf("expected one factory call, got %d", got)
	}
}

func TestConnectionManagerCreatesDifferentConnectionsWithoutGlobalDialLock(t *testing.T) {
	t.Parallel()

	cfg := &config.AppConfig{
		Connections: []config.ConnectionConfig{
			{ID: "pg-1", Type: "postgres"},
			{ID: "pg-2", Type: "postgres"},
		},
		EncryptionKey: "test-key",
	}

	manager := NewConnectionManager(cfg)
	started := make(chan string, 2)
	release := make(chan struct{})
	manager.RegisterFactory("postgres", func(_ context.Context, cfg config.ConnectionConfig, _ string) (Connector, error) {
		started <- cfg.ID
		<-release
		return &testManagerConnector{}, nil
	})

	errs := make(chan error, 2)
	for _, id := range []string{"pg-1", "pg-2"} {
		go func(connID string) {
			_, err := manager.Get(context.Background(), connID)
			errs <- err
		}(id)
	}

	seen := make(map[string]struct{})
	timeout := time.After(500 * time.Millisecond)
	for len(seen) < 2 {
		select {
		case id := <-started:
			seen[id] = struct{}{}
		case <-timeout:
			t.Fatalf("timed out waiting for independent connector creation, saw %#v", seen)
		}
	}
	close(release)

	for range 2 {
		if err := <-errs; err != nil {
			t.Fatalf("get failed: %v", err)
		}
	}
}

func TestConnectionManagerAppliesFailureCooldown(t *testing.T) {
	t.Parallel()

	cfg := &config.AppConfig{
		Connections: []config.ConnectionConfig{
			{ID: "pg-1", Type: "postgres"},
		},
		EncryptionKey: "test-key",
	}

	manager := NewConnectionManager(cfg)
	var calls atomic.Int32
	manager.RegisterFactory("postgres", func(context.Context, config.ConnectionConfig, string) (Connector, error) {
		calls.Add(1)
		return nil, ErrUnavailable
	})

	if _, err := manager.Get(context.Background(), "pg-1"); !errors.Is(err, ErrUnavailable) {
		t.Fatalf("expected unavailable error, got %v", err)
	}
	afterFirst := calls.Load()
	if _, err := manager.Get(context.Background(), "pg-1"); !errors.Is(err, ErrUnavailable) {
		t.Fatalf("expected cooldown unavailable error, got %v", err)
	}
	if got := calls.Load(); got != afterFirst {
		t.Fatalf("expected cooldown to skip the second factory dial, got %d extra call(s)", got-afterFirst)
	}
}
