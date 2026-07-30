package redis

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/zxchlorka/kizuna/internal/connector"
)

func TestRedisSafeString(t *testing.T) {
	tests := []struct {
		name    string
		in      string
		want    string
		wantBin bool
	}{
		{
			name: "plain ascii passes through",
			in:   "profile:123",
			want: "profile:123",
		},
		{
			name: "valid utf-8 passes through untouched",
			in:   "привет 🎉",
			want: "привет 🎉",
		},
		{
			name: "empty string passes through",
			in:   "",
			want: "",
		},
		{
			// Реальный префикс protobuf-значения со скриншота пользователя.
			// Печатный ASCII внутри бинаря сохраняется как есть — ровно так же
			// его показывают redis-cli и другие Redis-клиенты.
			name:    "protobuf payload becomes hex escapes",
			in:      string([]byte{0x12, 0xcb, 0x05, 0x0c, '(', '5', 'd', 0xd6}),
			want:    `\x12\xcb\x05\x0c(5d\xd6`,
			wantBin: true,
		},
		{
			name:    "lone continuation byte is escaped",
			in:      string([]byte{0x80}),
			want:    `\x80`,
			wantBin: true,
		},
		{
			name:    "backslash is escaped so the output is unambiguous",
			in:      string([]byte{0xff, '\\', 'x', '4', '1'}),
			want:    `\xff\\x41`,
			wantBin: true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, binary := redisSafeString(tt.in)
			if got != tt.want {
				t.Fatalf("redisSafeString(%q) = %q, want %q", tt.in, got, tt.want)
			}
			if binary != tt.wantBin {
				t.Fatalf("redisSafeString(%q) binary = %v, want %v", tt.in, binary, tt.wantBin)
			}
		})
	}
}

func TestRedisDataResultEscapesBinaryRows(t *testing.T) {
	rows := []map[string]any{
		{"field": "4", "value": string([]byte{0x12, 0xcb})},
		{"field": "name", "value": "alice"},
	}

	result := redisDataResult(
		[]connector.ColumnMeta{{Name: "field", DataType: "text"}, {Name: "value", DataType: "text", Editable: true}},
		rows,
		2,
		map[string]any{"type": "redis_hash"},
		0,
	)

	if got := result.Rows[0]["value"]; got != `\x12\xcb` {
		t.Fatalf("binary value = %q, want %q", got, `\x12\xcb`)
	}
	if got := result.Rows[1]["value"]; got != "alice" {
		t.Fatalf("text value = %q, want it untouched", got)
	}
	if result.Meta["has_binary"] != true {
		t.Fatalf("meta[has_binary] = %v, want true", result.Meta["has_binary"])
	}
}

func TestJSONSafeValueEscapesBinary(t *testing.T) {
	binary := string([]byte{0x12, 0xcb})
	const escaped = `\x12\xcb`

	tests := []struct {
		name string
		in   any
		want any
	}{
		{name: "binary string", in: binary, want: escaped},
		{name: "binary bytes", in: []byte(binary), want: escaped},
		{name: "text is untouched", in: "GET ok", want: "GET ok"},
		{name: "number is untouched", in: int64(7), want: int64(7)},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := jsonSafeValue(tt.in); got != tt.want {
				t.Fatalf("jsonSafeValue(%v) = %v, want %v", tt.in, got, tt.want)
			}
		})
	}

	// RESP3 отдаёт вложенные массивы и мапы — escape должен доставать и туда.
	nested := jsonSafeValue([]any{binary, "ok"})
	list, ok := nested.([]any)
	if !ok || list[0] != escaped || list[1] != "ok" {
		t.Fatalf("nested slice = %#v, want [%q ok]", nested, escaped)
	}

	inMap := jsonSafeValue(map[any]any{"field": binary})
	asMap, ok := inMap.(map[string]any)
	if !ok || asMap["field"] != escaped {
		t.Fatalf("nested map = %#v, want field=%q", inMap, escaped)
	}
}

// Полный путь Redis CLI: GET бинарного ключа не должен доезжать до JSON как
// U+FFFD. Именно так теряются байты — encoding/json заменяет каждый невалидный
// UTF-8 байт молча, без ошибки.
func TestFormatExecResultEscapesBinaryReply(t *testing.T) {
	c := &RedisConnector{}
	reply := string([]byte{0x12, 0xcb, 0x05, 0x0c, '(', '5', 'd', 0xd6})

	result, err := c.formatExecResult("GET binblob", []string{"GET", "binblob"}, reply, nil, 0)
	if err != nil {
		t.Fatalf("formatExecResult: %v", err)
	}

	got, _ := result.Rows[0][0].(string)
	if got != `\x12\xcb\x05\x0c(5d\xd6` {
		t.Fatalf("row value = %q, want %q", got, `\x12\xcb\x05\x0c(5d\xd6`)
	}

	encoded, err := json.Marshal(result)
	if err != nil {
		t.Fatalf("json.Marshal: %v", err)
	}
	if strings.Contains(string(encoded), "�") {
		t.Fatalf("serialized reply still contains U+FFFD: %s", encoded)
	}
}

func TestRedisDataResultLeavesCleanRowsAlone(t *testing.T) {
	result := redisDataResult(
		[]connector.ColumnMeta{{Name: "member", DataType: "text"}},
		[]map[string]any{{"member": "aa-1", "score": 1.5}},
		1,
		nil,
		0,
	)

	if _, present := result.Meta["has_binary"]; present {
		t.Fatalf("meta[has_binary] must be absent for clean rows, got %v", result.Meta["has_binary"])
	}
	if result.Rows[0]["score"] != 1.5 {
		t.Fatalf("non-string values must not be touched, got %v", result.Rows[0]["score"])
	}
}
