package postgres

import "testing"

func TestNormalizeCanonicalUUID(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name   string
		in     string
		want   string
		wantOK bool
	}{
		{
			name:   "valid lowercase",
			in:     "550e8400-e29b-41d4-a716-446655440000",
			want:   "550e8400-e29b-41d4-a716-446655440000",
			wantOK: true,
		},
		{
			name:   "valid uppercase trimmed",
			in:     " 550E8400-E29B-41D4-A716-446655440000 ",
			want:   "550e8400-e29b-41d4-a716-446655440000",
			wantOK: true,
		},
		{
			name:   "invalid",
			in:     "not-a-uuid",
			want:   "",
			wantOK: false,
		},
	}

	for _, tt := range tests {
		tt := tt
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			got, ok := normalizeCanonicalUUID(tt.in)
			if ok != tt.wantOK {
				t.Fatalf("ok mismatch: got %v want %v", ok, tt.wantOK)
			}
			if got != tt.want {
				t.Fatalf("value mismatch: got %q want %q", got, tt.want)
			}
		})
	}
}

func TestCoerceUUID_StrictStringOnly(t *testing.T) {
	t.Parallel()

	if _, err := coerceUUID([]byte{1, 2, 3}, "id"); err == nil {
		t.Fatal("expected error for non-string uuid input")
	}

	got, err := coerceUUID("550e8400-e29b-41d4-a716-446655440000", "id")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got != "550e8400-e29b-41d4-a716-446655440000" {
		t.Fatalf("unexpected uuid: %q", got)
	}
}
