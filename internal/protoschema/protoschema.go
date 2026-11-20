// Package protoschema reads Kafka message values written as protobuf, given the
// .proto contract a user attached to the topic.
package protoschema

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"slices"
	"strconv"
	"strings"

	"github.com/bufbuild/protocompile"
	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/reflect/protoreflect"
	"google.golang.org/protobuf/types/dynamicpb"
)

// Schema is one compiled .proto file.
type Schema struct {
	file     protoreflect.FileDescriptor
	messages []protoreflect.MessageDescriptor
}

// Compile parses and links a single .proto file. Only the well-known
// google/protobuf imports resolve: a contract that imports files of its own
// fails here, naming the import it could not find.
func Compile(ctx context.Context, fileName, source string) (*Schema, error) {
	compiler := protocompile.Compiler{
		Resolver: protocompile.WithStandardImports(&protocompile.SourceResolver{
			Accessor: protocompile.SourceAccessorFromMap(map[string]string{fileName: source}),
		}),
	}
	files, err := compiler.Compile(ctx, fileName)
	if err != nil {
		return nil, err
	}
	schema := &Schema{file: files[0]}
	schema.messages = collectMessages(files[0].Messages(), nil)
	if len(schema.messages) == 0 {
		return nil, errors.New(fileName + " has no message types")
	}
	return schema, nil
}

// collectMessages lists messages depth first, each before those nested in it.
// Map entries are the compiler's own types, never something a topic carries.
func collectMessages(list protoreflect.MessageDescriptors, acc []protoreflect.MessageDescriptor) []protoreflect.MessageDescriptor {
	for i := range list.Len() {
		message := list.Get(i)
		if message.IsMapEntry() {
			continue
		}
		acc = append(acc, message)
		acc = collectMessages(message.Messages(), acc)
	}
	return acc
}

// Messages returns the full names of the file's message types in declaration
// order.
func (s *Schema) Messages() []string {
	names := make([]string, len(s.messages))
	for i, message := range s.messages {
		names[i] = string(message.FullName())
	}
	return names
}

// DefaultMessage guesses which type the topic carries: the first message no
// other message of the file uses as a field. The parts of an event are referred
// to by it; the event itself is not.
func (s *Schema) DefaultMessage() string {
	referenced := map[protoreflect.FullName]bool{}
	var mark func(message protoreflect.MessageDescriptor)
	mark = func(message protoreflect.MessageDescriptor) {
		fields := message.Fields()
		for i := range fields.Len() {
			if target := fields.Get(i).Message(); target != nil {
				if target.IsMapEntry() {
					mark(target)
				} else {
					referenced[target.FullName()] = true
				}
			}
		}
	}
	for _, message := range s.messages {
		mark(message)
	}
	for _, message := range s.messages {
		if !referenced[message.FullName()] {
			return string(message.FullName())
		}
	}
	return string(s.messages[0].FullName())
}

// Decoder returns the decoder for one of the file's messages, by full name.
func (s *Schema) Decoder(message string) (*Decoder, error) {
	for _, candidate := range s.messages {
		if string(candidate.FullName()) == message {
			return &Decoder{message: candidate}, nil
		}
	}
	return nil, fmt.Errorf("%s has no message %q", s.file.Path(), message)
}

// Decoder turns wire bytes of one message type into JSON.
type Decoder struct {
	message protoreflect.MessageDescriptor
}

// Decode reports false when value is not this message. Protobuf parses almost
// anything without complaint, so a value of another type, or no protobuf at
// all, is recognised by what parsing leaves over: any field the contract does
// not declare, or declares with another wire type, ends up unknown.
func (d *Decoder) Decode(value []byte) (string, bool) {
	message := dynamicpb.NewMessage(d.message)
	if err := proto.Unmarshal(value, message); err != nil {
		return "", false
	}
	if hasUnknownFields(message) {
		return "", false
	}
	var buf bytes.Buffer
	writeMessage(&buf, message)
	return buf.String(), true
}

func hasUnknownFields(message protoreflect.Message) bool {
	if len(message.GetUnknown()) > 0 {
		return true
	}
	found := false
	message.Range(func(field protoreflect.FieldDescriptor, value protoreflect.Value) bool {
		switch {
		case field.IsMap():
			if field.MapValue().Message() != nil {
				value.Map().Range(func(_ protoreflect.MapKey, entry protoreflect.Value) bool {
					found = hasUnknownFields(entry.Message())
					return !found
				})
			}
		case field.IsList():
			if field.Message() != nil {
				list := value.List()
				for i := 0; i < list.Len() && !found; i++ {
					found = hasUnknownFields(list.Get(i).Message())
				}
			}
		case field.Message() != nil:
			found = hasUnknownFields(value.Message())
		}
		return !found
	})
	return found
}

// writeMessage writes the set fields in declaration order under their .proto
// names, the way the contract spells them and a search or export path names
// them. Unlike protojson, 64-bit integers are bare numbers: Kizuna reads JSON
// numbers losslessly, and an id quoted as a string would not match the same id
// in a JSON topic.
func writeMessage(buf *bytes.Buffer, message protoreflect.Message) {
	// The well-known types have a JSON form of their own: a Timestamp is a
	// date, not {"seconds":...}.
	if strings.HasPrefix(string(message.Descriptor().FullName()), "google.protobuf.") {
		if out, err := protojson.Marshal(message.Interface()); err == nil {
			buf.Write(out)
			return
		}
	}
	buf.WriteByte('{')
	fields := message.Descriptor().Fields()
	first := true
	for i := range fields.Len() {
		field := fields.Get(i)
		if !message.Has(field) {
			continue
		}
		if !first {
			buf.WriteByte(',')
		}
		first = false
		writeString(buf, string(field.Name()))
		buf.WriteByte(':')
		value := message.Get(field)
		switch {
		case field.IsMap():
			writeMap(buf, field, value.Map())
		case field.IsList():
			list := value.List()
			buf.WriteByte('[')
			for j := range list.Len() {
				if j > 0 {
					buf.WriteByte(',')
				}
				writeValue(buf, field, list.Get(j))
			}
			buf.WriteByte(']')
		default:
			writeValue(buf, field, value)
		}
	}
	buf.WriteByte('}')
}

func writeMap(buf *bytes.Buffer, field protoreflect.FieldDescriptor, entries protoreflect.Map) {
	keys := make([]protoreflect.MapKey, 0, entries.Len())
	entries.Range(func(key protoreflect.MapKey, _ protoreflect.Value) bool {
		keys = append(keys, key)
		return true
	})
	slices.SortFunc(keys, func(a, b protoreflect.MapKey) int { return strings.Compare(a.String(), b.String()) })
	buf.WriteByte('{')
	for i, key := range keys {
		if i > 0 {
			buf.WriteByte(',')
		}
		writeString(buf, key.String())
		buf.WriteByte(':')
		writeValue(buf, field.MapValue(), entries.Get(key))
	}
	buf.WriteByte('}')
}

func writeValue(buf *bytes.Buffer, field protoreflect.FieldDescriptor, value protoreflect.Value) {
	switch field.Kind() {
	case protoreflect.BoolKind:
		buf.WriteString(strconv.FormatBool(value.Bool()))
	case protoreflect.Int32Kind, protoreflect.Sint32Kind, protoreflect.Sfixed32Kind,
		protoreflect.Int64Kind, protoreflect.Sint64Kind, protoreflect.Sfixed64Kind:
		buf.WriteString(strconv.FormatInt(value.Int(), 10))
	case protoreflect.Uint32Kind, protoreflect.Fixed32Kind, protoreflect.Uint64Kind, protoreflect.Fixed64Kind:
		buf.WriteString(strconv.FormatUint(value.Uint(), 10))
	case protoreflect.FloatKind:
		writeFloat(buf, value.Float(), 32)
	case protoreflect.DoubleKind:
		writeFloat(buf, value.Float(), 64)
	case protoreflect.StringKind:
		writeString(buf, value.String())
	case protoreflect.BytesKind:
		writeString(buf, base64.StdEncoding.EncodeToString(value.Bytes()))
	case protoreflect.EnumKind:
		number := value.Enum()
		if known := field.Enum().Values().ByNumber(number); known != nil {
			writeString(buf, string(known.Name()))
		} else {
			buf.WriteString(strconv.FormatInt(int64(number), 10))
		}
	case protoreflect.MessageKind, protoreflect.GroupKind:
		writeMessage(buf, value.Message())
	}
}

// writeFloat spells NaN and the infinities as strings, as protojson does: JSON
// has no literal for them.
func writeFloat(buf *bytes.Buffer, value float64, bits int) {
	switch {
	case math.IsNaN(value):
		buf.WriteString(`"NaN"`)
	case math.IsInf(value, 1):
		buf.WriteString(`"Infinity"`)
	case math.IsInf(value, -1):
		buf.WriteString(`"-Infinity"`)
	default:
		buf.WriteString(strconv.FormatFloat(value, 'g', -1, bits))
	}
}

func writeString(buf *bytes.Buffer, value string) {
	// Marshalling a string cannot fail.
	out, _ := json.Marshal(value)
	buf.Write(out)
}
