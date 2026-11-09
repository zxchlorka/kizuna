package kafka

import (
	"errors"
	"slices"
	"testing"

	"github.com/zxchlorka/kizuna/internal/connector"
)

func TestExtractExportCells(t *testing.T) {
	tests := []struct {
		name      string
		value     string
		fields    []string
		wantCells []string
		wantFound bool
	}{
		{name: "int64 above 2^53 keeps its digits", value: `{"user_id":2091885016401416192}`, fields: []string{"user_id"}, wantCells: []string{"2091885016401416192"}, wantFound: true},
		{name: "nested key", value: `{"user":{"id":"u-1"}}`, fields: []string{"user.id"}, wantCells: []string{"u-1"}, wantFound: true},
		{name: "array path collects every element into one cell", value: `{"items":[{"id":1},{"id":2},{"id":3}]}`, fields: []string{"items[].id"}, wantCells: []string{"[1,2,3]"}, wantFound: true},
		{name: "array path with one element is still an array", value: `{"items":[{"id":1}]}`, fields: []string{"items[].id"}, wantCells: []string{"[1]"}, wantFound: true},
		{name: "array path over an empty array finds nothing", value: `{"items":[]}`, fields: []string{"items[].id"}, wantCells: []string{""}, wantFound: false},
		{name: "array path keeps large ints exact", value: `{"items":[{"id":9007199254740993}]}`, fields: []string{"items[].id"}, wantCells: []string{"[9007199254740993]"}, wantFound: true},
		{name: "object is written as compact JSON", value: `{"meta": {"a": 1}}`, fields: []string{"meta"}, wantCells: []string{`{"a":1}`}, wantFound: true},
		{name: "null counts as found with an empty cell", value: `{"user_id":null,"x":1}`, fields: []string{"user_id"}, wantCells: []string{""}, wantFound: true},
		{name: "bool", value: `{"ok":true}`, fields: []string{"ok"}, wantCells: []string{"true"}, wantFound: true},
		{name: "one of two fields missing", value: `{"a":1}`, fields: []string{"user_id", "a"}, wantCells: []string{"", "1"}, wantFound: true},
		{name: "all fields missing", value: `{"a":1}`, fields: []string{"user_id", "b"}, wantCells: []string{"", ""}, wantFound: false},
		{name: "bracket key with a dot", value: `{"a.b":{"id":7}}`, fields: []string{`["a.b"].id`}, wantCells: []string{"7"}, wantFound: true},
		{name: "key segment does not walk into an array", value: `{"user":[{"id":1}]}`, fields: []string{"user.id"}, wantCells: []string{""}, wantFound: false},
		{name: "path is anchored at the root", value: `{"outer":{"user_id":5}}`, fields: []string{"user_id"}, wantCells: []string{""}, wantFound: false},
		{name: "top-level array is reached through []", value: `[{"user_id":5}]`, fields: []string{"[].user_id"}, wantCells: []string{"[5]"}, wantFound: true},
		{name: "top-level array without [] finds nothing", value: `[1,2]`, fields: []string{"user_id"}, wantCells: []string{""}, wantFound: false},
		{name: "broken JSON", value: `{bad json`, fields: []string{"user_id"}, wantCells: []string{""}, wantFound: false},
		{name: "plain text", value: `plain text`, fields: []string{"user_id"}, wantCells: []string{""}, wantFound: false},
		{name: "empty value", value: ``, fields: []string{"user_id"}, wantCells: []string{""}, wantFound: false},
		{name: "string is written raw, escaping is the CSV writer's job", value: `{"s":"a,b \"q\"\nline"}`, fields: []string{"s"}, wantCells: []string{"a,b \"q\"\nline"}, wantFound: true},
		{name: "trailing garbage after the document is rejected", value: `{"user_id":1} {"user_id":2}`, fields: []string{"user_id"}, wantCells: []string{""}, wantFound: false},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			fields, err := parseExportFields(tt.fields)
			if err != nil {
				t.Fatalf("parseExportFields(%q): %v", tt.fields, err)
			}
			cells, found := extractExportCells([]byte(tt.value), fields)
			if found != tt.wantFound {
				t.Errorf("found = %v, want %v", found, tt.wantFound)
			}
			if !slices.Equal(cells, tt.wantCells) {
				t.Errorf("cells = %q, want %q", cells, tt.wantCells)
			}
		})
	}
}

func TestParseExportFields(t *testing.T) {
	tests := []struct {
		name       string
		fields     []string
		wantErr    bool
		wantFanOut []bool
	}{
		{name: "no fields", fields: nil, wantErr: true},
		{name: "blank field", fields: []string{""}, wantErr: true},
		{name: "separators only", fields: []string{" . "}, wantErr: true},
		{name: "plain and array paths", fields: []string{"user_id", "items[].id"}, wantFanOut: []bool{false, true}},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			fields, err := parseExportFields(tt.fields)
			if tt.wantErr {
				if !errors.Is(err, connector.ErrBadRequest) {
					t.Fatalf("err = %v, want ErrBadRequest", err)
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			got := make([]bool, len(fields))
			for i, field := range fields {
				got[i] = field.fanOut
			}
			if !slices.Equal(got, tt.wantFanOut) {
				t.Errorf("fanOut = %v, want %v", got, tt.wantFanOut)
			}
		})
	}
}
