package redis

import "testing"

func TestAttachSlotOwnership(t *testing.T) {
	t.Parallel()

	nodes := []redisNodeStat{
		{Address: "10.0.4.11:6379", Keys: 100},
		{Address: "10.0.4.12:6379", Keys: 200},
		// A master CLUSTER SLOTS said nothing about: it keeps its totals and
		// gains no slot fields, rather than being dropped from the table.
		{Address: "10.0.4.13:6379", Keys: 300},
	}
	owned := map[string]slotOwnership{
		"10.0.4.11:6379": {
			Ranges:   []clusterSlotRange{{Start: 0, End: 8191}},
			Slots:    8192,
			Replicas: 1,
		},
		"10.0.4.12:6379": {
			// Two disjoint spans, which is what a cluster looks like after a
			// reshard — the table has to add them up rather than show the first.
			Ranges:   []clusterSlotRange{{Start: 8192, End: 12287}, {Start: 15000, End: 16383}},
			Slots:    4096 + 1384,
			Replicas: 0,
		},
	}

	got, assigned := attachSlotOwnership(nodes, owned)

	if got[0].Slots != 8192 || got[0].Replicas != 1 {
		t.Fatalf("first master: got %d slots / %d replicas, want 8192 / 1", got[0].Slots, got[0].Replicas)
	}
	if len(got[1].SlotRanges) != 2 || got[1].Slots != 5480 {
		t.Fatalf("second master: got %d ranges / %d slots, want 2 / 5480", len(got[1].SlotRanges), got[1].Slots)
	}
	if got[1].Replicas != 0 {
		t.Fatalf("a master with no replica must report 0, got %d", got[1].Replicas)
	}
	if got[2].Slots != 0 || got[2].Keys != 300 {
		t.Fatalf("unlisted master must keep its totals and gain no slots: %+v", got[2])
	}

	// 16384 minus this is the part of the keyspace answering to nobody.
	if want := 8192 + 5480; assigned != want {
		t.Fatalf("assigned = %d, want %d", assigned, want)
	}
}
