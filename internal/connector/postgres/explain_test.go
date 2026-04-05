package postgres

import "testing"

func TestBuildExplainStatementUsesSafeExplain(t *testing.T) {
	t.Parallel()

	got := buildExplainStatement("SELECT * FROM users", false)
	want := "EXPLAIN (FORMAT JSON) SELECT * FROM users"
	if got != want {
		t.Fatalf("unexpected explain statement: got %q want %q", got, want)
	}
}

func TestBuildExplainStatementUsesAnalyze(t *testing.T) {
	t.Parallel()

	got := buildExplainStatement("SELECT * FROM users", true)
	want := "EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) SELECT * FROM users"
	if got != want {
		t.Fatalf("unexpected analyze statement: got %q want %q", got, want)
	}
}

func TestParseExplainPayloadMarksBottleneck(t *testing.T) {
	t.Parallel()

	raw := []byte(`[
	  {
	    "Plan": {
	      "Node Type": "Nested Loop",
	      "Startup Cost": 0.5,
	      "Total Cost": 50,
	      "Plan Rows": 10,
	      "Actual Rows": 10,
	      "Actual Total Time": 5,
	      "Plans": [
	        {
	          "Node Type": "Seq Scan",
	          "Relation Name": "users",
	          "Startup Cost": 0,
	          "Total Cost": 20,
	          "Plan Rows": 100,
	          "Actual Rows": 100,
	          "Actual Total Time": 2
	        },
	        {
	          "Node Type": "Hash Join",
	          "Startup Cost": 5,
	          "Total Cost": 80,
	          "Plan Rows": 1000,
	          "Actual Rows": 1000,
	          "Actual Total Time": 8
	        }
	      ]
	    }
	  }
	]`)

	plan, err := parseExplainPayload(raw)
	if err != nil {
		t.Fatalf("parse explain payload: %v", err)
	}
	markBottleneck(&plan)

	if plan.NodeType != "Nested Loop" {
		t.Fatalf("unexpected root node: %q", plan.NodeType)
	}
	if len(plan.Children) != 2 {
		t.Fatalf("unexpected child count: %d", len(plan.Children))
	}
	if !plan.Children[1].IsBottleneck {
		t.Fatalf("expected highest cost child to be bottleneck")
	}
	if plan.IsBottleneck {
		t.Fatalf("did not expect root to be bottleneck")
	}
}

func TestParseExplainPayloadWithoutAnalyzeFields(t *testing.T) {
	t.Parallel()

	raw := []byte(`[
	  {
	    "Plan": {
	      "Node Type": "Seq Scan",
	      "Relation Name": "users",
	      "Startup Cost": 0,
	      "Total Cost": 12.5,
	      "Plan Rows": 42
	    }
	  }
	]`)

	plan, err := parseExplainPayload(raw)
	if err != nil {
		t.Fatalf("parse explain payload: %v", err)
	}

	if plan.NodeType != "Seq Scan" {
		t.Fatalf("unexpected node type: %q", plan.NodeType)
	}
	if plan.TotalCost != 12.5 {
		t.Fatalf("unexpected total cost: %v", plan.TotalCost)
	}
	if plan.ActualTimeMs != 0 {
		t.Fatalf("expected zero actual time for safe explain, got %v", plan.ActualTimeMs)
	}
}
