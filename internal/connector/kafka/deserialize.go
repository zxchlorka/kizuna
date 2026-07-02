package kafka

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"unicode/utf8"

	"github.com/twmb/franz-go/pkg/kgo"
)

// deserializePayload auto-detects the payload shape. Avro/Protobuf via Schema
// Registry is a future slice; until then the format is json, text, or binary.
func deserializePayload(data []byte) (string, string) {
	if len(data) == 0 {
		return "", "empty"
	}

	trimmed := bytes.TrimSpace(data)
	if len(trimmed) > 0 && (trimmed[0] == '{' || trimmed[0] == '[') {
		var value any
		if json.Unmarshal(trimmed, &value) == nil {
			return string(data), "json"
		}
	}

	if utf8.Valid(data) {
		return string(data), "text"
	}

	return base64.StdEncoding.EncodeToString(data), "binary"
}

func recordHeaders(record *kgo.Record) map[string]string {
	if len(record.Headers) == 0 {
		return nil
	}
	headers := make(map[string]string, len(record.Headers))
	for _, header := range record.Headers {
		value, _ := deserializePayload(header.Value)
		headers[header.Key] = value
	}
	return headers
}
