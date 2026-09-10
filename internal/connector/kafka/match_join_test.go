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

// "not equals" is the strict negation, so a message that never carried the
// field satisfies it. Without that reading, "show me non-batch events" has to
// be written as "not batch OR no field" every time — and the field is exactly
// what a message of another shape is missing.
func TestNotEqualsMatchesMessagesWithoutTheField(t *testing.T) {
	t.Parallel()

	query := parseMatchQuery([]connector.FilterExpr{
		{Column: "match_field", Op: "eq", Value: "event_type"},
		{Column: "match_value", Op: "eq", Value: "batch"},
		{Column: "match_op", Op: "eq", Value: "not_eq"},
	})

	tests := []struct {
		name  string
		value string
		want  bool
	}{
		{name: "another value", value: `{"event_type":"single"}`, want: true},
		{name: "no field at all", value: `{"src":{}}`, want: true},
		{name: "the excluded value", value: `{"event_type":"batch"}`, want: false},
	}

	for _, tc := range tests {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			row := map[string]any{"format": "json", "value": tc.value}
			if got := messageMatchesQuery(row, query); got != tc.want {
				t.Fatalf("matched = %v, want %v", got, tc.want)
			}
		})
	}
}

func TestNotContainsOnAKey(t *testing.T) {
	t.Parallel()

	query := parseMatchQuery([]connector.FilterExpr{
		{Column: "match_target", Op: "eq", Value: "key"},
		{Column: "match_value", Op: "eq", Value: "abc"},
		{Column: "match_op", Op: "eq", Value: "not_contains"},
	})

	if !messageMatchesQuery(map[string]any{"key": "xyz"}, query) {
		t.Fatal("a key without the substring must match")
	}
	if messageMatchesQuery(map[string]any{"key": "xxabcxx"}, query) {
		t.Fatal("a key containing the substring must not match")
	}
	if !messageMatchesQuery(map[string]any{}, query) {
		t.Fatal("a record with no key must match, the same way a missing field does")
	}
}

// The fixture that actually pins the precedence, and the one the first round of
// tests was missing: with A and B false and C true,
//
//	A and B or C
//
// is FALSE under "or binds tighter" (A and (B or C) = false and true) and TRUE
// under the conventional left-to-right reading ((A and B) or C = false or true).
// Every earlier fixture agreed under both, so none of them would have noticed
// the precedence quietly flipping.
func TestPrecedenceDistinguishesOrTighterFromLeftToRight(t *testing.T) {
	t.Parallel()

	query := parseMatchQuery([]connector.FilterExpr{
		{Column: "match_field", Op: "eq", Value: "a"},
		{Column: "match_op", Op: "eq", Value: "exists"},
		{Column: "match_field.1", Op: "eq", Value: "b"},
		{Column: "match_op.1", Op: "eq", Value: "exists"},
		{Column: "match_join.1", Op: "eq", Value: "and"},
		{Column: "match_field.2", Op: "eq", Value: "c"},
		{Column: "match_op.2", Op: "eq", Value: "exists"},
		{Column: "match_join.2", Op: "eq", Value: "or"},
	})

	// Only c is present: A false, B false, C true.
	row := map[string]any{"format": "json", "value": `{"c":1}`}
	if messageMatchesQuery(row, query) {
		t.Fatal("A and B or C must be false when only C holds — or binds tighter than and")
	}
}

// A payload that is not JSON satisfies no value predicate, negatives included.
// Negating a helper that fails on unparseable input is what made the browser
// include these while the server excluded them.
func TestNegativesRejectNonJSONPayloads(t *testing.T) {
	t.Parallel()

	for _, op := range []string{"not_eq", "not_contains"} {
		op := op
		t.Run(op, func(t *testing.T) {
			t.Parallel()
			query := parseMatchQuery([]connector.FilterExpr{
				{Column: "match_field", Op: "eq", Value: "event_type"},
				{Column: "match_value", Op: "eq", Value: "batch"},
				{Column: "match_op", Op: "eq", Value: op},
			})
			row := map[string]any{"format": "text", "value": "plain log line, not json"}
			if messageMatchesQuery(row, query) {
				t.Fatalf("%s must not match a non-JSON payload", op)
			}
		})
	}
}

// Negation over an array asks that NO element carries the excluded value, which
// is not the same as "some element differs" — a message holding both the
// excluded value and another one must be rejected.
func TestNegationOverAnArrayRequiresNoElementToMatch(t *testing.T) {
	t.Parallel()

	query := parseMatchQuery([]connector.FilterExpr{
		{Column: "match_field", Op: "eq", Value: "events[].name"},
		{Column: "match_value", Op: "eq", Value: "batch"},
		{Column: "match_op", Op: "eq", Value: "not_eq"},
	})

	tests := []struct {
		name  string
		value string
		want  bool
	}{
		{name: "no element carries it", value: `{"events":[{"name":"a"},{"name":"b"}]}`, want: true},
		{name: "one element among others carries it", value: `{"events":[{"name":"a"},{"name":"batch"}]}`, want: false},
		{name: "every element carries it", value: `{"events":[{"name":"batch"}]}`, want: false},
	}

	for _, tc := range tests {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			row := map[string]any{"format": "json", "value": tc.value}
			if got := messageMatchesQuery(row, query); got != tc.want {
				t.Fatalf("matched = %v, want %v", got, tc.want)
			}
		})
	}
}

// The counterpart of the TypeScript "value matching searches nested paths"
// suite: both sides try the path from the root and then from every nested
// value, so one filter gets one answer whichever side runs it.
func TestNestedPathsAnswerTheSameOnBothSides(t *testing.T) {
	t.Parallel()

	const nested = `{"event_type":"single","nested":{"event_type":"batch"}}`
	row := map[string]any{"format": "json", "value": nested}

	equals := parseMatchQuery([]connector.FilterExpr{
		{Column: "match_field", Op: "eq", Value: "event_type"},
		{Column: "match_value", Op: "eq", Value: "batch"},
		{Column: "match_op", Op: "eq", Value: "equals"},
	})
	if !messageMatchesQuery(row, equals) {
		t.Fatal("a value nested below the root must be found")
	}

	notEquals := parseMatchQuery([]connector.FilterExpr{
		{Column: "match_field", Op: "eq", Value: "event_type"},
		{Column: "match_value", Op: "eq", Value: "batch"},
		{Column: "match_op", Op: "eq", Value: "not_eq"},
	})
	if messageMatchesQuery(row, notEquals) {
		t.Fatal("negation must reject a message where the excluded value occurs anywhere")
	}
}
