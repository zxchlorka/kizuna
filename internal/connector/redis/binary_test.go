package redis

import (
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
