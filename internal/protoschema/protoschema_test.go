package protoschema

import (
	"context"
	"strings"
	"testing"

	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/encoding/protowire"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/reflect/protoreflect"
	"google.golang.org/protobuf/types/dynamicpb"
)

// A made-up contract of the shape real ones have: a nested repeated message,
// an int64 past 2^53, an enum, bytes, a map and a well-known import.
const demoProto = `syntax = "proto3";

package demo.events.v1;

import "google/protobuf/timestamp.proto";

enum Source {
  SOURCE_UNSPECIFIED = 0;
  SOURCE_WEB = 1;
  SOURCE_APP = 2;
}

message Tag {
  string name = 1;
  int64 weight = 2;
}

message ProfileEvent {
  int64 user_id = 1;
  repeated Tag tags = 2;
  Source source = 3;
  bytes token = 4;
  map<string, int32> counters = 5;
  google.protobuf.Timestamp seen_at = 6;
  double score = 7;
  bool active = 8;
}

message Note {
  string text = 1;
  string extra = 9;
}
`

func compileDemo(t *testing.T) *Schema {
	t.Helper()
	schema, err := Compile(context.Background(), "demo.proto", demoProto)
	if err != nil {
		t.Fatalf("compile: %v", err)
	}
	return schema
}

// encode builds the wire bytes of message from its protojson form.
func encode(t *testing.T, schema *Schema, message, jsonText string) []byte {
	t.Helper()
	descriptor := schema.file.Messages().ByName(protoNameOf(message))
	if descriptor == nil {
		t.Fatalf("no message %s", message)
	}
	msg := dynamicpb.NewMessage(descriptor)
	if err := protojson.Unmarshal([]byte(jsonText), msg); err != nil {
		t.Fatalf("protojson: %v", err)
	}
	wire, err := proto.Marshal(msg)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	return wire
}

func protoNameOf(full string) protoreflect.Name {
	return protoreflect.Name(full[strings.LastIndex(full, ".")+1:])
}

func TestCompileListsMessagesAndPicksTheTopOne(t *testing.T) {
	schema := compileDemo(t)
	got := strings.Join(schema.Messages(), ",")
	want := "demo.events.v1.Tag,demo.events.v1.ProfileEvent,demo.events.v1.Note"
	if got != want {
		t.Fatalf("messages = %s, want %s", got, want)
	}
	// Tag is a field of ProfileEvent, so the first message nothing refers to.
	if got := schema.DefaultMessage(); got != "demo.events.v1.ProfileEvent" {
		t.Fatalf("default = %s", got)
	}
}

func TestCompileErrors(t *testing.T) {
	tests := []struct {
		name   string
		source string
		want   string
	}{
		{name: "syntax error names the line", source: "syntax = \"proto3\";\nmessage A {\n  int64 = 1;\n}\n", want: "demo.proto:3"},
		{name: "own imports are not available", source: "syntax = \"proto3\";\nimport \"other/thing.proto\";\nmessage A { int64 id = 1; }\n", want: "other/thing.proto"},
		{name: "no messages", source: "syntax = \"proto3\";\nenum E { E_ZERO = 0; }\n", want: "no message"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			_, err := Compile(context.Background(), "demo.proto", tt.source)
			if err == nil || !strings.Contains(err.Error(), tt.want) {
				t.Fatalf("err = %v, want it to mention %q", err, tt.want)
			}
		})
	}
}

func TestDecoderUnknownMessage(t *testing.T) {
	if _, err := compileDemo(t).Decoder("demo.events.v1.Missing"); err == nil {
		t.Fatal("want an error for a message the file does not have")
	}
}

func TestDecode(t *testing.T) {
	schema := compileDemo(t)
	event, err := schema.Decoder("demo.events.v1.ProfileEvent")
	if err != nil {
		t.Fatal(err)
	}
	note, err := schema.Decoder("demo.events.v1.Note")
	if err != nil {
		t.Fatal(err)
	}

	full := encode(t, schema, "demo.events.v1.ProfileEvent", `{
		"userId": "9007199254740993",
		"tags": [{"name": "a", "weight": "1"}, {"name": "b"}],
		"source": "SOURCE_APP",
		"token": "AQI=",
		"counters": {"y": 2, "x": 3},
		"seenAt": "2026-03-01T12:00:00Z",
		"score": 0.5,
		"active": true
	}`)
	// Fields in declaration order under their .proto names, defaults left out,
	// the int64 as a bare number with every digit, map keys sorted.
	wantFull := `{"user_id":9007199254740993,"tags":[{"name":"a","weight":1},{"name":"b"}],"source":"SOURCE_APP","token":"AQI=","counters":{"x":3,"y":2},"seen_at":"2026-03-01T12:00:00Z","score":0.5,"active":true}`

	// The producer moved on to a newer contract: fields 17-20 are not in ours.
	var newer []byte
	newer = append(newer, full...)
	newer = protowire.AppendTag(newer, 17, protowire.BytesType)
	newer = protowire.AppendString(newer, "alpha")
	newer = protowire.AppendTag(newer, 18, protowire.VarintType)
	newer = protowire.AppendVarint(newer, 3)
	newer = protowire.AppendTag(newer, 18, protowire.VarintType)
	newer = protowire.AppendVarint(newer, 4)
	newer = protowire.AppendTag(newer, 19, protowire.BytesType)
	newer = protowire.AppendBytes(newer, []byte{0x08, 0x05})
	newer = protowire.AppendTag(newer, 20, protowire.BytesType)
	newer = protowire.AppendBytes(newer, []byte{0xff})
	wantNewer := strings.TrimSuffix(wantFull, "}") + `,"17":"alpha","18":[3,4],"19":{"1":5},"20":"/w=="}`

	// A Tag carrying a field 9 it does not declare.
	nestedUnknown := []byte{0x12, 0x0b, 0x0a, 0x06, 'a', 'b', 'c', 'd', 'e', 'f', 0x4a, 0x01, 'z'}
	// user_id 5, then a field 17 several times its size.
	mostlyUnknown := []byte{0x08, 0x05, 0x8a, 0x01, 0x06, 'a', 'b', 'c', 'd', 'e', 'f'}

	tests := []struct {
		name    string
		decoder *Decoder
		value   []byte
		want    string
		wantOK  bool
	}{
		{name: "every kind of field", decoder: event, value: full, want: wantFull, wantOK: true},
		{name: "enum value the contract does not know stays a number", decoder: event, value: []byte{0x18, 0x07}, want: `{"source":7}`, wantOK: true},
		{name: "JSON is not this message", decoder: event, value: []byte(`{"user_id":1}`)},
		{name: "plain text is not this message", decoder: event, value: []byte("hello world")},
		{name: "fields of a newer contract show under their numbers", decoder: event, value: newer, want: wantNewer, wantOK: true},
		{name: "unknown field inside a nested message", decoder: event, value: nestedUnknown, want: `{"tags":[{"name":"abcdef","9":"z"}]}`, wantOK: true},
		{name: "mostly unknown is not this message", decoder: event, value: mostlyUnknown},
		{name: "another message with a field this one lacks", decoder: event, value: encode(t, schema, "demo.events.v1.Note", `{"text":"x","extra":"y"}`)},
		{name: "string that is not UTF-8", decoder: note, value: []byte{0x0a, 0x01, 0xff}},
		{name: "truncated", decoder: event, value: full[:len(full)-3]},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, ok := tt.decoder.Decode(tt.value)
			if ok != tt.wantOK {
				t.Fatalf("ok = %v (got %s), want %v", ok, got, tt.wantOK)
			}
			if ok && got != tt.want {
				t.Fatalf("got  %s\nwant %s", got, tt.want)
			}
		})
	}
}
