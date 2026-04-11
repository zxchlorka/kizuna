package connector

import (
	"context"
	"testing"

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
