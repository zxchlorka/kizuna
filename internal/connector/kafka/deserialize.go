package kafka

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"unicode/utf8"

	"github.com/twmb/franz-go/pkg/kgo"
	"github.com/zxchlorka/kizuna/internal/connector"
)

// formatProtobuf marks a value read with the topic's .proto contract. Its value
// is JSON, so everything that works on a JSON message works on it too.
const formatProtobuf = "protobuf"

// deserializePayload auto-detects the payload shape: json, text, or binary.
// Protobuf needs the topic's contract; see deserializeValue.
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

// deserializeValue is deserializePayload for a message value, which the
// topic's decoder, when there is one, reads first unless the value is JSON.
// Before text, too: a small protobuf message is often valid UTF-8.
func deserializeValue(data []byte, decoder connector.PayloadDecoder) (string, string) {
	value, format := deserializePayload(data)
	if decoder == nil || format == "json" || format == "empty" {
		return value, format
	}
	if decoded, ok := decoder.Decode(data); ok {
		return decoded, formatProtobuf
	}
	return value, format
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
