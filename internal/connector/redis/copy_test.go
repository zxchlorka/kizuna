package redis

import (
	"reflect"
	"testing"
)

func TestAppendChunkedSplitsByElementNotArgument(t *testing.T) {
	t.Parallel()

	// Three field/value pairs with a chunk of two elements must split after the
	// second PAIR, not after the second argument — a chunk cut mid-pair would
	// send HSET a field with no value.
	args := []any{"f1", "v1", "f2", "v2", "f3", "v3"}
	got := appendChunkedWith(2, nil, "HSET", "dst", args, 2)

	want := [][]any{
		{"HSET", "dst", "f1", "v1", "f2", "v2"},
		{"HSET", "dst", "f3", "v3"},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("chunked to %#v, want %#v", got, want)
	}
}

func TestRetargetWritesRenamesEveryCommand(t *testing.T) {
	t.Parallel()

	writes := [][]any{
		{"HSET", "old", "f", "v"},
		{"PEXPIRE", "old", int64(1000)},
	}
	got := retargetWrites(writes, "new")

	for _, args := range got {
		if args[1] != "new" {
			t.Fatalf("command %v still points at %v", args[0], args[1])
		}
	}
	// The source must survive untouched: an export is reused when the first
	// import is refused, and mutating it in place would retarget the retry too.
	if writes[0][1] != "old" {
		t.Fatal("retargetWrites modified the export it was given")
	}
}

func TestUnwrapJSONRoot(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name string
		in   string
		want string
	}{
		// JSON.GET "$" answers with the matches in an array. Written back as-is
		// the document would gain an array wrapper on every copy.
		{name: "unwraps the matched root", in: `[{"a":1}]`, want: `{"a":1}`},
		{name: "tolerates whitespace", in: "  [ {\"a\":1} ]  ", want: `{"a":1}`},
		{name: "leaves a bare document alone", in: `{"a":1}`, want: `{"a":1}`},
	}

	for _, tc := range tests {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			if got := unwrapJSONRoot(tc.in); got != tc.want {
				t.Fatalf("unwrapJSONRoot(%q) = %q, want %q", tc.in, got, tc.want)
			}
		})
	}
}
