package kafka

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"strconv"

	"github.com/zxchlorka/kizuna/internal/connector"
)

// exportField is one column of a field export: a parsed canonical path and
// whether it fans out over an array ('[]' anywhere in it). A fanned-out field is
// always written as a JSON array, even with a single element, so a column never
// changes shape from one row to the next.
type exportField struct {
	path   []jsonPathSegment
	fanOut bool
}

func parseExportFields(fields []string) ([]exportField, error) {
	if len(fields) == 0 {
		return nil, fmt.Errorf("%w: at least one field is required", connector.ErrBadRequest)
	}
	parsed := make([]exportField, 0, len(fields))
	for _, field := range fields {
		path := parseJSONPath(field)
		if len(path) == 0 {
			return nil, fmt.Errorf("%w: invalid field path %q", connector.ErrBadRequest, field)
		}
		field := exportField{path: path}
		for _, segment := range path {
			if segment.kind == jsonPathIndex {
				field.fanOut = true
				break
			}
		}
		parsed = append(parsed, field)
	}
	return parsed, nil
}

// extractExportCells renders one message as a CSV row. found is false when none
// of the fields is present (or the value is not a JSON document at all), which
// is the caller's cue to leave the message out of the file.
//
// Paths resolve strictly from the root, unlike the search matcher which retries
// a path at every depth: a search asks "is it anywhere", an export column has to
// name exactly one place, or one row's user_id would come from somewhere else
// than the next row's.
func extractExportCells(value []byte, fields []exportField) ([]string, bool) {
	cells := make([]string, len(fields))
	// UseNumber so an int64 id keeps its digits; as float64 it would read back as
	// a different id.
	decoder := json.NewDecoder(bytes.NewReader(value))
	decoder.UseNumber()
	var document any
	if decoder.Decode(&document) != nil {
		return cells, false
	}
	if _, err := decoder.Token(); err != io.EOF {
		return cells, false
	}

	found := false
	for i, field := range fields {
		values := resolveExportPath(document, field.path, nil)
		if len(values) == 0 {
			continue
		}
		found = true
		if field.fanOut {
			cells[i] = exportJSON(values)
		} else {
			cells[i] = exportCell(values[0])
		}
	}
	return cells, found
}

// resolveExportPath appends every value the path reaches. A key segment
// descends objects only and '[]' descends arrays only, so without '[]' it
// yields at most one value.
func resolveExportPath(value any, path []jsonPathSegment, acc []any) []any {
	if len(path) == 0 {
		return append(acc, value)
	}
	segment := path[0]
	switch typed := value.(type) {
	case map[string]any:
		if segment.kind == jsonPathKey {
			if child, ok := typed[segment.key]; ok {
				return resolveExportPath(child, path[1:], acc)
			}
		}
	case []any:
		if segment.kind == jsonPathIndex {
			for _, child := range typed {
				acc = resolveExportPath(child, path[1:], acc)
			}
		}
	}
	return acc
}

func exportCell(value any) string {
	switch typed := value.(type) {
	case nil:
		return ""
	case string:
		return typed
	case json.Number:
		return typed.String()
	case bool:
		return strconv.FormatBool(typed)
	default:
		return exportJSON(typed)
	}
}

// exportJSON writes objects and arrays compactly. HTML escaping is off: the
// cell is data for a spreadsheet or a script, and "<" there is just noise.
func exportJSON(value any) string {
	var buf bytes.Buffer
	encoder := json.NewEncoder(&buf)
	encoder.SetEscapeHTML(false)
	// Encoding a decoded JSON value cannot fail.
	_ = encoder.Encode(value)
	return string(bytes.TrimRight(buf.Bytes(), "\n"))
}
