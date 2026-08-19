package kafka

import (
	"testing"

	"github.com/zxchlorka/kizuna/internal/connector"
)

// A record whose payload is not JSON at all: the point of key and header
// conditions is that they still work here, where a payload path cannot.
func binaryRecord() map[string]any {
	return map[string]any{
		"key":     "user-42",
		"value":   "AQIDBA==",
		"format":  "binary",
		"headers": map[string]string{"trace-id": "abc-123-def", "source": "checkout"},
	}
}

func TestMessageMatchesFilterOnKeyAndHeaders(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name   string
		filter contentFilter
		row    map[string]any
		want   bool
	}{
		{
			name:   "key equals",
			filter: contentFilter{target: matchTargetKey, value: "user-42", op: matchOpEquals},
			row:    binaryRecord(),
			want:   true,
		},
		{
			name:   "key equals is exact",
			filter: contentFilter{target: matchTargetKey, value: "user-4", op: matchOpEquals},
			row:    binaryRecord(),
			want:   false,
		},
		{
			name:   "key contains",
			filter: contentFilter{target: matchTargetKey, value: "-42", op: matchOpContains},
			row:    binaryRecord(),
			want:   true,
		},
		{
			name:   "key exists",
			filter: contentFilter{target: matchTargetKey, op: matchOpExists},
			row:    binaryRecord(),
			want:   true,
		},
		{
			// A record produced without a key: absent, not empty.
			name:   "key missing on a keyless record",
			filter: contentFilter{target: matchTargetKey, op: matchOpMissing},
			row:    map[string]any{"key": "", "value": "{}", "format": "json"},
			want:   true,
		},
		{
			name:   "key equals never matches a keyless record",
			filter: contentFilter{target: matchTargetKey, value: "", op: matchOpEquals},
			row:    map[string]any{"key": "", "value": "{}", "format": "json"},
			want:   false,
		},
		{
			name:   "header equals",
			filter: contentFilter{target: matchTargetHeader, field: "source", value: "checkout", op: matchOpEquals},
			row:    binaryRecord(),
			want:   true,
		},
		{
			name:   "header contains",
			filter: contentFilter{target: matchTargetHeader, field: "trace-id", value: "123", op: matchOpContains},
			row:    binaryRecord(),
			want:   true,
		},
		{
			name:   "header exists",
			filter: contentFilter{target: matchTargetHeader, field: "trace-id", op: matchOpExists},
			row:    binaryRecord(),
			want:   true,
		},
		{
			name:   "header missing",
			filter: contentFilter{target: matchTargetHeader, field: "tenant", op: matchOpMissing},
			row:    binaryRecord(),
			want:   true,
		},
		{
			name:   "header on a record with no headers at all",
			filter: contentFilter{target: matchTargetHeader, field: "trace-id", op: matchOpExists},
			row:    map[string]any{"key": "k", "value": "{}", "format": "json"},
			want:   false,
		},
		{
			// Header names are case-sensitive in Kafka, and so is this.
			name:   "header name case matters",
			filter: contentFilter{target: matchTargetHeader, field: "Source", op: matchOpExists},
			row:    binaryRecord(),
			want:   false,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			if got := messageMatchesFilter(tt.row, tt.filter); got != tt.want {
				t.Fatalf("matched = %v, want %v", got, tt.want)
			}
		})
	}
}

func TestPayloadContainsOp(t *testing.T) {
	t.Parallel()

	row := map[string]any{
		"value":  `{"url":"https://example.test/checkout?trace=abc-123","attempts":42}`,
		"format": "json",
	}

	if !messageMatchesFilter(row, contentFilter{field: "url", value: "trace=abc-123", op: matchOpContains, target: matchTargetValue}) {
		t.Error("substring of a string leaf should match")
	}
	if !messageMatchesFilter(row, contentFilter{field: "attempts", value: "4", op: matchOpContains, target: matchTargetValue}) {
		t.Error("a number leaf should be searchable as its rendered text")
	}
	if messageMatchesFilter(row, contentFilter{field: "url", value: "not-there", op: matchOpContains, target: matchTargetValue}) {
		t.Error("absent substring should not match")
	}
}

func TestParseMatchQueryTargets(t *testing.T) {
	t.Parallel()

	query := parseMatchQuery([]connector.FilterExpr{
		{Column: "match_target", Value: "key"},
		{Column: "match_op", Value: "contains"},
		{Column: "match_value", Value: "user-"},
		{Column: "match_target.1", Value: "header"},
		{Column: "match_field.1", Value: "trace-id"},
		{Column: "match_value.1", Value: "abc"},
	})

	if len(query.filters) != 2 {
		t.Fatalf("filters = %+v, want 2", query.filters)
	}
	// A key condition carries no field and must survive the drop that removes
	// blank rows.
	if query.filters[0].target != matchTargetKey || query.filters[0].op != matchOpContains {
		t.Errorf("key condition = %+v", query.filters[0])
	}
	if query.filters[1].target != matchTargetHeader || query.filters[1].field != "trace-id" {
		t.Errorf("header condition = %+v", query.filters[1])
	}
}

func TestParseMatchQueryDropsBlankNonKeyConditions(t *testing.T) {
	t.Parallel()

	query := parseMatchQuery([]connector.FilterExpr{
		{Column: "match_target", Value: "header"},
		{Column: "match_value", Value: "orphan"},
	})
	if len(query.filters) != 0 {
		t.Fatalf("a header condition with no name should be dropped, got %+v", query.filters)
	}
}
