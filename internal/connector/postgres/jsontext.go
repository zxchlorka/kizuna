package postgres

import (
	"encoding/json"

	"github.com/jackc/pgx/v5/pgtype"
)

// json/jsonb columns are read as the text Postgres stored, not as a decoded Go
// value.
//
// By default pgx decodes them with encoding/json into `any`, which makes every
// number a float64. A document holding an int64 — a snowflake id, a bigint
// reference — is then re-encoded from that float64 and reaches the browser
// rounded: 2091885016401416192 becomes 2091885016401416200, an id that matches
// no row and no key. Postgres already renders the document exactly, so the
// bytes are passed through untouched and the frontend parses them without
// going through a double either (see frontend/src/lib/json.ts).
//
// Registered per connection because a pgx type map belongs to a connection.
// Only `any` targets are intercepted: a Scan into a concrete type still
// unmarshals normally, which is what the EXPLAIN and catalog queries rely on.
func registerJSONAsText(m *pgtype.Map) {
	m.RegisterType(&pgtype.Type{
		Name:  "json",
		OID:   pgtype.JSONOID,
		Codec: &pgtype.JSONCodec{Marshal: json.Marshal, Unmarshal: unmarshalJSONKeepingText},
	})
	m.RegisterType(&pgtype.Type{
		Name:  "jsonb",
		OID:   pgtype.JSONBOID,
		Codec: &pgtype.JSONBCodec{Marshal: json.Marshal, Unmarshal: unmarshalJSONKeepingText},
	})
}

func unmarshalJSONKeepingText(data []byte, target any) error {
	if into, ok := target.(*any); ok {
		*into = string(data)
		return nil
	}
	return json.Unmarshal(data, target)
}
