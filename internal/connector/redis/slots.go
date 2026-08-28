package redis

import (
	"context"
	"sort"
	"strings"
	"sync"

	goredis "github.com/redis/go-redis/v9"
)

// Slot ownership — which master answers for which part of the keyspace.
//
// The Masters table already says how much each node holds. This says WHICH
// slots it holds, and that is the difference between "node .13 is bigger" and
// "node .13 owns a sixth of the slots and a third of the keys". A cluster is
// only ever rebalanced by moving slots, so ranges are the unit any fix is
// written in — a table of totals cannot name the thing you would move.
//
// Read from CLUSTER SLOTS rather than CLUSTER SHARDS: SHARDS needs Redis 7,
// SLOTS is answered by every cluster-mode server including Dragonfly's
// emulated one, and it carries everything shown here.

// clusterSlotRange is one contiguous span a master owns, inclusive at both ends.
type clusterSlotRange struct {
	Start int `json:"start"`
	End   int `json:"end"`
}

// slotOwnership is one master's share of the 16384-slot space.
type slotOwnership struct {
	Ranges   []clusterSlotRange
	Slots    int
	Replicas int
}

func (t *goredisClusterTopology) SlotOwnership(ctx context.Context) (map[string]slotOwnership, error) {
	// Keyed by node id, not by the address CLUSTER SLOTS reports.
	//
	// A cluster announces the address it believes it has, which is routinely not
	// the address a client dialled: behind a proxy, inside Docker, or with
	// cluster-announce-ip set, the two differ. Matching those strings silently
	// yielded a table with every slot column empty — the map looked broken while
	// every other figure was right. Node ids are the cluster's own identity for
	// a node and survive all of it.
	dialledByID, err := t.masterIDs(ctx)
	if err != nil {
		return nil, err
	}

	slots, err := t.cluster.ClusterSlots(ctx).Result()
	if err != nil {
		return nil, normalizeRedisError(err)
	}

	// Replicas are counted as distinct nodes across every range the master
	// owns, not per range: the same replica set serves all of them, and adding
	// the per-range counts would multiply one replica into several.
	replicaAddrs := make(map[string]map[string]struct{}, 8)
	owned := make(map[string]slotOwnership, 8)

	for _, slot := range slots {
		if len(slot.Nodes) == 0 {
			continue
		}
		master, ok := dialledByID[slot.Nodes[0].ID]
		if !ok {
			// A master the scan side does not know about — a replica promoted
			// between the two calls, most likely. Skipping keeps the totals
			// honest instead of inventing a row.
			continue
		}

		own := owned[master]
		own.Ranges = append(own.Ranges, clusterSlotRange{Start: slot.Start, End: slot.End})
		own.Slots += slot.End - slot.Start + 1
		owned[master] = own

		if replicaAddrs[master] == nil {
			replicaAddrs[master] = make(map[string]struct{}, 2)
		}
		for _, node := range slot.Nodes[1:] {
			// Counted by id for the same reason the master is looked up by one.
			if node.ID != "" {
				replicaAddrs[master][node.ID] = struct{}{}
			}
		}
	}

	for master, own := range owned {
		// Sorted so the ribbon can be drawn straight from the response and two
		// refreshes never reorder the same cluster.
		sort.Slice(own.Ranges, func(i, j int) bool { return own.Ranges[i].Start < own.Ranges[j].Start })
		own.Replicas = len(replicaAddrs[master])
		owned[master] = own
	}

	return owned, nil
}

// masterIDs maps each master's node id to the address this client actually
// reaches it on — the same address Masters() returns, so the slot data lands on
// the rows the Overview already built.
func (t *goredisClusterTopology) masterIDs(ctx context.Context) (map[string]string, error) {
	var mu sync.Mutex
	dialled := make(map[string]string, 8)

	err := t.cluster.ForEachMaster(ctx, func(ctx context.Context, client *goredis.Client) error {
		id, err := client.Do(ctx, "CLUSTER", "MYID").Text()
		if err != nil {
			return err
		}
		id = strings.TrimSpace(id)
		if id == "" {
			return nil
		}
		mu.Lock()
		defer mu.Unlock()
		dialled[id] = resolveRedisAddress(client.Options().Addr)
		return nil
	})
	if err != nil {
		return nil, normalizeRedisError(err)
	}
	return dialled, nil
}

// attachSlotOwnership fills the slot fields on already-collected node stats.
//
// Failure here is deliberately not fatal: the Masters table is useful without
// slot ranges, and an Overview that refuses to render because CLUSTER SLOTS was
// unavailable would be a worse answer than one missing a column.
func attachSlotOwnership(nodes []redisNodeStat, owned map[string]slotOwnership) (stats []redisNodeStat, assigned int) {
	for index, node := range nodes {
		own, ok := owned[node.Address]
		if !ok {
			continue
		}
		nodes[index].Slots = own.Slots
		nodes[index].SlotRanges = own.Ranges
		nodes[index].Replicas = own.Replicas
		assigned += own.Slots
	}
	return nodes, assigned
}
