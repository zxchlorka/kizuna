package history

import (
	"fmt"
	"path/filepath"
	"sync"
	"testing"

	"github.com/zxchlorka/kizuna/internal/connector"
)

// The SQL console reads history the instant it cancels a batch, so a reader
// racing the write must see either none of that batch or all of it. Appending
// one entry at a time let it see a prefix, which is indistinguishable from a
// batch that simply ended early -- the console then reported the run as
// finished while the cancelled statement was still on its way to disk.
func TestAppendManyIsAtomicForConcurrentReaders(t *testing.T) {
	t.Parallel()

	dir := t.TempDir()
	store := NewStore(filepath.Join(dir, "config.json"))

	batch := make([]connector.HistoryEntry, 0, 4)
	for i := range 4 {
		batch = append(batch, connector.HistoryEntry{
			ID:         fmt.Sprintf("b%d", i),
			Command:    fmt.Sprintf("SELECT %d", i),
			ExecutedAt: "2026-04-05T00:00:00Z",
			Canceled:   i == 3,
		})
	}

	var wg sync.WaitGroup
	readCounts := make(chan int, 200)

	wg.Add(1)
	go func() {
		defer wg.Done()
		for range 200 {
			items, err := store.List("conn-atomic", 0, "")
			if err != nil {
				t.Errorf("list history: %v", err)
				return
			}
			readCounts <- len(items)
		}
	}()

	wg.Add(1)
	go func() {
		defer wg.Done()
		if err := store.AppendMany("conn-atomic", batch); err != nil {
			t.Errorf("append batch: %v", err)
		}
	}()

	wg.Wait()
	close(readCounts)

	// Every observation is either "batch not there yet" or "all of it".
	for count := range readCounts {
		if count != 0 && count != len(batch) {
			t.Fatalf("reader observed a partial batch: %d of %d entries", count, len(batch))
		}
	}
}

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
