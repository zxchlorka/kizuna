package history

import (
	"path/filepath"
	"testing"

	"github.com/zxchlorka/kizuna/internal/connector"
)

func TestStoreAppendListAndClear(t *testing.T) {
	t.Parallel()

	dir := t.TempDir()
	store := NewStore(filepath.Join(dir, "config.json"))

	for i := 0; i < 105; i++ {
		err := store.Append("conn-1", connector.HistoryEntry{
			ID:         string(rune('a' + (i % 26))),
			Command:    "SELECT " + string(rune('a'+(i%26))),
			DurationMs: int64(i),
			ExecutedAt: "2026-04-05T00:00:00Z",
		})
		if err != nil {
			t.Fatalf("append history: %v", err)
		}
	}

	items, err := store.List("conn-1", 10, "select")
	if err != nil {
		t.Fatalf("list history: %v", err)
	}
	if len(items) != 10 {
		t.Fatalf("unexpected history length: got %d", len(items))
	}
	if items[0].DurationMs != 104 {
		t.Fatalf("expected newest entry first, got duration %d", items[0].DurationMs)
	}

	allItems, err := store.List("conn-1", 0, "")
	if err != nil {
		t.Fatalf("list all history: %v", err)
	}
	if len(allItems) != 100 {
		t.Fatalf("expected FIFO cap of 100, got %d", len(allItems))
	}

	if err := store.Clear("conn-1"); err != nil {
		t.Fatalf("clear history: %v", err)
	}
	empty, err := store.List("conn-1", 10, "")
	if err != nil {
		t.Fatalf("list after clear: %v", err)
	}
	if len(empty) != 0 {
		t.Fatalf("expected empty history after clear, got %d entries", len(empty))
	}
}
