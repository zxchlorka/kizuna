package kafka

import (
	"testing"

	"github.com/zxchlorka/kizuna/internal/connector"
)

// Реальная форма сообщения из топика: массив с одним объектом. Metadata
// опциональна — её может не быть вообще.
const (
	docWithMetadata = `[{"UserID":2000,"Field":"DisableVectors","Metadata":{"marketing_device_id":"test-marketing-device-id"}}]`
	docNoMetadata   = `[{"UserID":2000,"Field":"Gender","AdditionalInfo":"{\"ip\":\"10.26.170.154\"}"}]`
	docNullMetadata = `[{"UserID":2000,"Metadata":null}]`
	docDeepMetadata = `[{"UserID":2000,"wrapper":{"inner":{"Metadata":{"marketing_device_id":"x"}}}}]`
)

func jsonRow(value string) map[string]any {
	return map[string]any{"format": "json", "value": value}
}

func TestMessageMatchesFieldExistsAndMissing(t *testing.T) {
	tests := []struct {
		name  string
		row   map[string]any
		field string
		op    matchOp
		want  bool
	}{
		// exists — значение неважно, важен сам факт наличия поля.
		{name: "exists finds a top-level optional field", row: jsonRow(docWithMetadata), field: "Metadata", op: matchOpExists, want: true},
		{name: "exists does not match when the field is absent", row: jsonRow(docNoMetadata), field: "Metadata", op: matchOpExists, want: false},
		{name: "exists treats a null value as present", row: jsonRow(docNullMetadata), field: "Metadata", op: matchOpExists, want: true},
		{name: "exists finds a nested field by leaf name", row: jsonRow(docWithMetadata), field: "marketing_device_id", op: matchOpExists, want: true},
		{name: "exists finds a field at any depth", row: jsonRow(docDeepMetadata), field: "Metadata", op: matchOpExists, want: true},
		{name: "exists accepts a partial path", row: jsonRow(docWithMetadata), field: "Metadata.marketing_device_id", op: matchOpExists, want: true},
		{name: "exists accepts the explicit array path", row: jsonRow(docWithMetadata), field: "[].Metadata", op: matchOpExists, want: true},
		{name: "exists does not match a sibling field name", row: jsonRow(docWithMetadata), field: "Nope", op: matchOpExists, want: false},

		// missing — обратное к exists, но только для валидного JSON.
		{name: "missing matches a message without the field", row: jsonRow(docNoMetadata), field: "Metadata", op: matchOpMissing, want: true},
		{name: "missing does not match when the field is there", row: jsonRow(docWithMetadata), field: "Metadata", op: matchOpMissing, want: false},
		{name: "missing does not match when the value is null but present", row: jsonRow(docNullMetadata), field: "Metadata", op: matchOpMissing, want: false},

		// eq — прежнее поведение не меняется.
		{name: "eq still matches on value", row: jsonRow(docWithMetadata), field: "Field", op: matchOpEquals, want: true},
		{name: "eq still rejects a different value", row: jsonRow(docNoMetadata), field: "Field", op: matchOpEquals, want: false},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			want := ""
			if tt.op == matchOpEquals {
				want = "DisableVectors"
			}
			if got := messageMatchesField(tt.row, tt.field, want, tt.op); got != tt.want {
				t.Fatalf("messageMatchesField(%q, op=%s) = %v, want %v", tt.field, tt.op, got, tt.want)
			}
		})
	}
}

// Не-JSON payload не матчится ни одним оператором, включая missing: у него нет
// JSON-полей по определению, и включение таких сообщений утопило бы выдачу.
func TestMessageMatchesFieldIgnoresNonJSON(t *testing.T) {
	row := map[string]any{"format": "text", "value": "plain payload"}
	for _, op := range []matchOp{matchOpEquals, matchOpExists, matchOpMissing} {
		if messageMatchesField(row, "Metadata", "", op) {
			t.Fatalf("op %s matched a non-JSON message", op)
		}
	}
}

func TestParseMatchFilterOp(t *testing.T) {
	tests := []struct {
		name    string
		filters []connector.FilterExpr
		want    matchOp
	}{
		{
			name:    "absent match_op defaults to equals",
			filters: []connector.FilterExpr{{Column: "match_field", Op: "eq", Value: "Field"}},
			want:    matchOpEquals,
		},
		{
			name: "exists is parsed",
			filters: []connector.FilterExpr{
				{Column: "match_field", Op: "eq", Value: "Metadata"},
				{Column: "match_op", Op: "eq", Value: "exists"},
			},
			want: matchOpExists,
		},
		{
			name: "missing is parsed case-insensitively",
			filters: []connector.FilterExpr{
				{Column: "match_field", Op: "eq", Value: "Metadata"},
				{Column: "match_op", Op: "eq", Value: "MISSING"},
			},
			want: matchOpMissing,
		},
		{
			name: "an unknown op falls back to equals",
			filters: []connector.FilterExpr{
				{Column: "match_field", Op: "eq", Value: "Metadata"},
				{Column: "match_op", Op: "eq", Value: "regex"},
			},
			want: matchOpEquals,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			_, _, op := parseMatchFilter(tt.filters)
			if op != tt.want {
				t.Fatalf("parseMatchFilter op = %q, want %q", op, tt.want)
			}
		})
	}
}
