package kafka

import (
	"bytes"
	"testing"
)

// fakeDecoder accepts values starting with its prefix, the way a protobuf
// decoder accepts only its own message type.
type fakeDecoder struct {
	prefix []byte
	out    string
}

func (d fakeDecoder) Decode(value []byte) (string, bool) {
	if bytes.HasPrefix(value, d.prefix) {
		return d.out, true
	}
	return "", false
}

func TestDeserializeValueWithDecoder(t *testing.T) {
	decoder := fakeDecoder{prefix: []byte{0x0a}, out: `{"user_id":7}`}
	tests := []struct {
		name       string
		data       []byte
		decoder    *fakeDecoder
		wantFormat string
		wantValue  string
	}{
		{name: "binary the decoder reads", data: []byte{0x0a, 0xff, 0x00}, decoder: &decoder, wantFormat: "protobuf", wantValue: `{"user_id":7}`},
		// Small protobuf messages are often valid UTF-8 and used to show as text.
		{name: "text-looking bytes the decoder reads", data: []byte("\n\x05hello"), decoder: &decoder, wantFormat: "protobuf", wantValue: `{"user_id":7}`},
		{name: "binary the decoder rejects stays binary", data: []byte{0xff, 0xfe}, decoder: &decoder, wantFormat: "binary", wantValue: "//4="},
		{name: "JSON is left alone", data: []byte("{\n\"a\":1}"), decoder: &fakeDecoder{prefix: []byte("{"), out: "never"}, wantFormat: "json", wantValue: "{\n\"a\":1}"},
		{name: "empty stays empty", data: nil, decoder: &fakeDecoder{prefix: nil, out: "never"}, wantFormat: "empty", wantValue: ""},
		{name: "no decoder, no change", data: []byte{0x0a, 0xff, 0x00}, wantFormat: "binary", wantValue: "Cv8A"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			var value, format string
			if tc.decoder != nil {
				value, format = deserializeValue(tc.data, *tc.decoder)
			} else {
				value, format = deserializeValue(tc.data, nil)
			}
			if format != tc.wantFormat || value != tc.wantValue {
				t.Fatalf("got (%q, %q), want (%q, %q)", value, format, tc.wantValue, tc.wantFormat)
			}
		})
	}
}

func TestFinalizeRowDecodesValueOnly(t *testing.T) {
	raw := map[string]any{"partition": int32(0), "offset": int64(1), "timestamp": "t", rawKeyField: []byte{0x0a, 0xff}, rawValueField: []byte{0x0a, 0xff}}
	row := finalizeRow(raw, fakeDecoder{prefix: []byte{0x0a}, out: `{"id":1}`})
	if row["format"] != "protobuf" || row["value"] != `{"id":1}` {
		t.Fatalf("value = %v (%v)", row["value"], row["format"])
	}
	if row["key"] != "Cv8=" {
		t.Fatalf("key = %v, want it left as base64", row["key"])
	}
}

func TestMessageMatchesFieldInProtobufRow(t *testing.T) {
	row := map[string]any{"format": "protobuf", "value": `{"user_id":9007199254740993}`}
	if !messageMatchesField(row, "user_id", "9007199254740993", matchOpEquals) {
		t.Fatal("a decoded protobuf value should be searchable like JSON")
	}
}
