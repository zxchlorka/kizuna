package postgres

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/qsnake66/kizuna/internal/connector"
)

type explainEnvelope struct {
	Plan          explainPlanNode `json:"Plan"`
	PlanningTime  float64         `json:"Planning Time"`
	ExecutionTime float64         `json:"Execution Time"`
}

type explainPlanNode struct {
	NodeType         string            `json:"Node Type"`
	RelationName     string            `json:"Relation Name"`
	Alias            string            `json:"Alias"`
	StartupCost      float64           `json:"Startup Cost"`
	TotalCost        float64           `json:"Total Cost"`
	PlanRows         int64             `json:"Plan Rows"`
	ActualRows       float64           `json:"Actual Rows"`
	ActualTotalTime  float64           `json:"Actual Total Time"`
	SharedHitBlocks  int64             `json:"Shared Hit Blocks"`
	SharedReadBlocks int64             `json:"Shared Read Blocks"`
	Plans            []explainPlanNode `json:"Plans"`
}

func (p *PostgresConnector) Explain(ctx context.Context, query string) (*connector.ExplainResult, error) {
	return p.runExplain(ctx, query, false)
}

func (p *PostgresConnector) Analyze(ctx context.Context, query string) (*connector.ExplainResult, error) {
	return p.runExplain(ctx, query, true)
}

func (p *PostgresConnector) runExplain(ctx context.Context, query string, analyze bool) (*connector.ExplainResult, error) {
	trimmed := strings.TrimSpace(query)
	if trimmed == "" {
		return nil, fmt.Errorf("%w: query is required", connector.ErrBadRequest)
	}

	startedAt := time.Now()
	statement := buildExplainStatement(trimmed, analyze)

	var raw []byte
	if err := p.pool.QueryRow(ctx, statement).Scan(&raw); err != nil {
		return nil, normalizePostgresError(err)
	}

	plan, err := parseExplainPayload(raw)
	if err != nil {
		return nil, fmt.Errorf("%w: invalid explain payload: %s", connector.ErrBadRequest, err.Error())
	}
	markBottleneck(&plan)

	return &connector.ExplainResult{
		Plan:       plan,
		DurationMs: time.Since(startedAt).Milliseconds(),
		Mode:       explainMode(analyze),
	}, nil
}

func buildExplainStatement(query string, analyze bool) string {
	if analyze {
		return "EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) " + query
	}
	return "EXPLAIN (FORMAT JSON) " + query
}

func explainMode(analyze bool) string {
	if analyze {
		return "analyze"
	}
	return "explain"
}

func parseExplainPayload(raw []byte) (connector.ExplainNode, error) {
	var envelopes []explainEnvelope
	if err := json.Unmarshal(raw, &envelopes); err != nil {
		return connector.ExplainNode{}, err
	}
	if len(envelopes) == 0 {
		return connector.ExplainNode{}, fmt.Errorf("empty explain payload")
	}
	return toExplainNode(envelopes[0].Plan), nil
}

func toExplainNode(node explainPlanNode) connector.ExplainNode {
	children := make([]connector.ExplainNode, 0, len(node.Plans))
	for _, child := range node.Plans {
		children = append(children, toExplainNode(child))
	}
	return connector.ExplainNode{
		NodeType:         node.NodeType,
		RelationName:     node.RelationName,
		Alias:            node.Alias,
		StartupCost:      node.StartupCost,
		TotalCost:        node.TotalCost,
		PlanRows:         node.PlanRows,
		ActualRows:       node.ActualRows,
		ActualTimeMs:     node.ActualTotalTime,
		SharedHitBlocks:  node.SharedHitBlocks,
		SharedReadBlocks: node.SharedReadBlocks,
		Children:         children,
	}
}

func markBottleneck(root *connector.ExplainNode) {
	if root == nil {
		return
	}
	best := root
	walkExplain(root, func(node *connector.ExplainNode) {
		if node.TotalCost > best.TotalCost {
			best = node
		}
	})
	best.IsBottleneck = true
}

func walkExplain(node *connector.ExplainNode, visit func(*connector.ExplainNode)) {
	visit(node)
	for idx := range node.Children {
		walkExplain(&node.Children[idx], visit)
	}
}
