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
	"unicode"
	"unicode/utf8"

	"github.com/bufbuild/protocompile"
	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/encoding/protowire"
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
// not declare, or declares with another wire type, ends up unknown. A producer
// on a newer contract leaves some over too, so a value passes while most of its
// bytes are fields the contract knows, and the rest show under their numbers.
func (d *Decoder) Decode(value []byte) (string, bool) {
	message := dynamicpb.NewMessage(d.message)
	if err := proto.Unmarshal(value, message); err != nil {
		return "", false
	}
	if 2*unknownBytes(message) > len(value) {
		return "", false
	}
	var buf bytes.Buffer
	writeMessage(&buf, message)
	return buf.String(), true
}

func unknownBytes(message protoreflect.Message) int {
	total := len(message.GetUnknown())
	message.Range(func(field protoreflect.FieldDescriptor, value protoreflect.Value) bool {
		switch {
		case field.IsMap():
			if field.MapValue().Message() != nil {
				value.Map().Range(func(_ protoreflect.MapKey, entry protoreflect.Value) bool {
					total += unknownBytes(entry.Message())
					return true
				})
			}
		case field.IsList():
			if field.Message() != nil {
				list := value.List()
				for i := range list.Len() {
					total += unknownBytes(list.Get(i).Message())
				}
			}
		case field.Message() != nil:
			total += unknownBytes(value.Message())
		}
		return true
	})
	return total
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
	// Proto3 parsing keeps undeclared fields as raw wire bytes, always whole.
	if raw, ok := parseRaw(message.GetUnknown()); ok {
		writeRawFields(buf, raw, !first)
	}
	buf.WriteByte('}')
}

// rawField is a wire field read without a contract: a number for the varint
// and fixed types, the payload for the length-delimited and group ones.
type rawField struct {
	number protowire.Number
	typ    protowire.Type
	n      uint64
	data   []byte
}

// parseRaw splits b into wire fields; false unless it is a whole run of them.
func parseRaw(b []byte) ([]rawField, bool) {
	var fields []rawField
	for len(b) > 0 {
		number, typ, n := protowire.ConsumeTag(b)
		if n < 0 {
			return nil, false
		}
		b = b[n:]
		field := rawField{number: number, typ: typ}
		switch typ {
		case protowire.VarintType:
			field.n, n = protowire.ConsumeVarint(b)
		case protowire.Fixed32Type:
			var v uint32
			v, n = protowire.ConsumeFixed32(b)
			field.n = uint64(v)
		case protowire.Fixed64Type:
			field.n, n = protowire.ConsumeFixed64(b)
		case protowire.BytesType:
			field.data, n = protowire.ConsumeBytes(b)
		default:
			n = protowire.ConsumeFieldValue(number, typ, b)
			if n >= 0 {
				field.data = b[:n]
			}
		}
		if n < 0 {
			return nil, false
		}
		b = b[n:]
		fields = append(fields, field)
	}
	return fields, true
}

// writeRawFields writes fields as JSON members keyed by field number, a number
// seen more than once as an array. The wire does not say which type a field
// was declared with, so the most readable reading is taken: an integer, text,
// a nested message, else base64.
func writeRawFields(buf *bytes.Buffer, fields []rawField, comma bool) {
	var order []protowire.Number
	byNumber := map[protowire.Number][]rawField{}
	for _, field := range fields {
		if _, seen := byNumber[field.number]; !seen {
			order = append(order, field.number)
		}
		byNumber[field.number] = append(byNumber[field.number], field)
	}
	for _, number := range order {
		if comma {
			buf.WriteByte(',')
		}
		comma = true
		writeString(buf, strconv.Itoa(int(number)))
		buf.WriteByte(':')
		values := byNumber[number]
		if len(values) == 1 {
			writeRawValue(buf, values[0])
			continue
		}
		buf.WriteByte('[')
		for i, value := range values {
			if i > 0 {
				buf.WriteByte(',')
			}
			writeRawValue(buf, value)
		}
		buf.WriteByte(']')
	}
}

func writeRawValue(buf *bytes.Buffer, field rawField) {
	switch field.typ {
	case protowire.BytesType:
		if isText(field.data) {
			writeString(buf, string(field.data))
			return
		}
		if nested, ok := parseRaw(field.data); ok && len(nested) > 0 {
			buf.WriteByte('{')
			writeRawFields(buf, nested, false)
			buf.WriteByte('}')
			return
		}
		writeString(buf, base64.StdEncoding.EncodeToString(field.data))
	case protowire.StartGroupType:
		writeString(buf, base64.StdEncoding.EncodeToString(field.data))
	default:
		buf.WriteString(strconv.FormatUint(field.n, 10))
	}
}

// isText is true for UTF-8 without control characters other than whitespace,
// which a nested message almost always has in its tags and lengths.
func isText(b []byte) bool {
	return utf8.Valid(b) && !bytes.ContainsFunc(b, func(r rune) bool {
		return unicode.IsControl(r) && r != '\t' && r != '\n' && r != '\r'
	})
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
