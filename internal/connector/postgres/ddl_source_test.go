package postgres

import (
	"math"
	"testing"
)

func TestSequenceParamsNonDefault(t *testing.T) {
	seq := func(start, inc, min, max, cache int64, cycle bool) sequenceParams {
		return sequenceParams{&start, &inc, &min, &max, &cache, &cycle}
	}
	tests := []struct {
		name string
		typ  string
		seq  sequenceParams
		want string
	}{
		{"plain bigint identity", "bigint", seq(1, 1, 1, math.MaxInt64, 1, false), ""},
		{"plain integer serial", "integer", seq(1, 1, 1, math.MaxInt32, 1, false), ""},
		{"start and step", "bigint", seq(100, 10, 1, math.MaxInt64, 1, false), "START WITH 100 INCREMENT BY 10"},
		{"raised minvalue starts there by default", "bigint", seq(50, 1, 50, math.MaxInt64, 1, false), "MINVALUE 50"},
		{"descending defaults", "integer", seq(-1, -1, math.MinInt32, -1, 1, false), "INCREMENT BY -1"},
		{"smallint bounds, cache and cycle", "smallint", seq(1, 1, 1, 1000, 20, true), "MAXVALUE 1000 CACHE 20 CYCLE"},
		{"no sequence", "bigint", sequenceParams{}, ""},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := tt.seq.nonDefault(tt.typ); got != tt.want {
				t.Fatalf("got %q, want %q", got, tt.want)
			}
		})
	}
}
