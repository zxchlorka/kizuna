package kafka

import "testing"

func TestScanFrontier(t *testing.T) {
	t.Parallel()

	rows := []map[string]any{
		{"timestamp": "2026-08-28T09:05:13.5Z"},
		{"timestamp": "2026-08-28T09:05:13Z"},
		{"timestamp": "2026-08-28T09:05:20.25Z"},
		{"timestamp": ""},
		{"offset": int64(7)},
	}

	tests := []struct {
		name      string
		direction readDirection
		want      string
	}{
		// Walking back from the newest end, the frontier is the oldest record
		// seen — that is how far into the past this step got.
		{name: "newest first reports the oldest", direction: directionNewest, want: "2026-08-28T09:05:13Z"},
		{name: "oldest first reports the newest", direction: directionOldest, want: "2026-08-28T09:05:20.25Z"},
	}

	for _, tc := range tests {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			got, ok := scanFrontier(rows, tc.direction)
			if !ok {
				t.Fatal("expected a frontier from rows that carry timestamps")
			}
			if got != tc.want {
				t.Fatalf("scanFrontier = %q, want %q", got, tc.want)
			}
		})
	}
}

// RFC3339Nano writes no fraction at all for a whole second, and 'Z' sorts above
// '.', so comparing these as strings puts 13.5 before 13 and reports a frontier
// that is ahead of where the scan really is.
func TestScanFrontierDoesNotCompareTimestampsAsText(t *testing.T) {
	t.Parallel()

	rows := []map[string]any{
		{"timestamp": "2026-08-28T09:05:13.5Z"},
		{"timestamp": "2026-08-28T09:05:13Z"},
	}

	got, _ := scanFrontier(rows, directionNewest)
	if got != "2026-08-28T09:05:13Z" {
		t.Fatalf("oldest is %q, want the whole second 2026-08-28T09:05:13Z", got)
	}
}

func TestScanFrontierWithoutTimestamps(t *testing.T) {
	t.Parallel()

	if _, ok := scanFrontier([]map[string]any{{"offset": int64(1)}}, directionNewest); ok {
		t.Fatal("rows without timestamps must report no frontier rather than a zero time")
	}
	if _, ok := scanFrontier(nil, directionOldest); ok {
		t.Fatal("an empty step must report no frontier")
	}
}
