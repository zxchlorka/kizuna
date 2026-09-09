package kafka

import (
	"testing"

	"github.com/zxchlorka/kizuna/internal/connector"
)

// The case this exists for, in the user's words: non-batch events whose name is
// one of a pool.
//
//	event_type != batch  AND  name = Carousel_All  OR  name = CheckingItems
//
// Neither old mode could ask it: "all" demanded both names at once, "any"
// matched every batch event that happened to carry one of them.
func TestMixedJoinersGroupOrTighterThanAnd(t *testing.T) {
	t.Parallel()

	filters := []connector.FilterExpr{
		{Column: "match_field", Op: "eq", Value: "event_type"},
		{Column: "match_value", Op: "eq", Value: "batch"},
		{Column: "match_op", Op: "eq", Value: "missing"},
		{Column: "match_field.1", Op: "eq", Value: "src.event_data.cp.name"},
		{Column: "match_value.1", Op: "eq", Value: "Carousel_All"},
		{Column: "match_op.1", Op: "eq", Value: "equals"},
		{Column: "match_join.1", Op: "eq", Value: "and"},
		{Column: "match_field.2", Op: "eq", Value: "src.event_data.cp.name"},
		{Column: "match_value.2", Op: "eq", Value: "CheckingItems"},
		{Column: "match_op.2", Op: "eq", Value: "equals"},
		{Column: "match_join.2", Op: "eq", Value: "or"},
	}
	query := parseMatchQuery(filters)

	row := func(value string) map[string]any {
		return map[string]any{"format": "json", "value": value}
	}

	tests := []struct {
		name  string
		value string
		want  bool
	}{
		{
			name:  "no event_type, first name",
			value: `{"src":{"event_data":{"cp":{"name":"Carousel_All"}}}}`,
			want:  true,
		},
		{
			name:  "no event_type, second name",
			value: `{"src":{"event_data":{"cp":{"name":"CheckingItems"}}}}`,
			want:  true,
		},
		{
			// Fails the AND half: the OR group holds, the batch check does not.
			name:  "batch event with a wanted name",
			value: `{"event_type":"batch","src":{"event_data":{"cp":{"name":"Carousel_All"}}}}`,
			want:  false,
		},
		{
			// Fails the OR half: nothing in the pool matches.
			name:  "no event_type, unwanted name",
			value: `{"src":{"event_data":{"cp":{"name":"Something_Else"}}}}`,
			want:  false,
		},
	}

	for _, tc := range tests {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			if got := messageMatchesQuery(row(tc.value), query); got != tc.want {
				t.Fatalf("matched = %v, want %v", got, tc.want)
			}
		})
	}
}

// Without joiners the old flat modes must answer exactly as they did.
func TestJoinersDefaultToTheLegacyModes(t *testing.T) {
	t.Parallel()

	base := []connector.FilterExpr{
		{Column: "match_field", Op: "eq", Value: "a"},
		{Column: "match_value", Op: "eq", Value: "1"},
		{Column: "match_op", Op: "eq", Value: "equals"},
		{Column: "match_field.1", Op: "eq", Value: "b"},
		{Column: "match_value.1", Op: "eq", Value: "2"},
		{Column: "match_op.1", Op: "eq", Value: "equals"},
	}
	row := map[string]any{"format": "json", "value": `{"a":1,"b":99}`}

	andQuery := parseMatchQuery(append(append([]connector.FilterExpr{}, base...),
		connector.FilterExpr{Column: "match_mode", Op: "eq", Value: "and"}))
	if messageMatchesQuery(row, andQuery) {
		t.Fatal("AND must reject a message that satisfies only one condition")
	}

	orQuery := parseMatchQuery(append(append([]connector.FilterExpr{}, base...),
		connector.FilterExpr{Column: "match_mode", Op: "eq", Value: "or"}))
	if !messageMatchesQuery(row, orQuery) {
		t.Fatal("OR must accept a message that satisfies one condition")
	}
}

// Order decides the answer once joiners differ, so the numbering has to survive
// however the caller's key/value list arrives.
func TestConditionsAreOrderedByTheirNumber(t *testing.T) {
	t.Parallel()

	shuffled := []connector.FilterExpr{
		{Column: "match_field.2", Op: "eq", Value: "c"},
		{Column: "match_op.2", Op: "eq", Value: "exists"},
		{Column: "match_join.2", Op: "eq", Value: "or"},
		{Column: "match_field", Op: "eq", Value: "a"},
		{Column: "match_op", Op: "eq", Value: "exists"},
		{Column: "match_field.1", Op: "eq", Value: "b"},
		{Column: "match_op.1", Op: "eq", Value: "exists"},
		{Column: "match_join.1", Op: "eq", Value: "and"},
	}
	query := parseMatchQuery(shuffled)

	got := make([]string, 0, len(query.filters))
	for _, filter := range query.filters {
		got = append(got, filter.field)
	}
	if len(got) != 3 || got[0] != "a" || got[1] != "b" || got[2] != "c" {
		t.Fatalf("conditions came out as %v, want [a b c]", got)
	}
}
