package kafka

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"slices"
	"testing"
	"time"

	"github.com/twmb/franz-go/pkg/kadm"
	"github.com/twmb/franz-go/pkg/kgo"
	"github.com/zxchlorka/kizuna/internal/config"
	"github.com/zxchlorka/kizuna/internal/connector"
)

// exportSeed is what the test knows about one produced record, so every
// scenario can compute its expected rows from the same list.
type exportSeed struct {
	partition int32
	offset    int64
	at        time.Time
	userID    string
	kind      string
}

func TestExportFieldsIntegration(t *testing.T) {
	broker := os.Getenv("KAFKA_TEST_BROKER")
	if broker == "" {
		t.Skip("set KAFKA_TEST_BROKER to run the local Kafka integration test")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()

	seedClient, err := kgo.NewClient(kgo.SeedBrokers(broker), kgo.RecordPartitioner(kgo.ManualPartitioner()))
	if err != nil {
		t.Fatalf("create seed client: %v", err)
	}
	defer seedClient.Close()
	admin := kadm.NewClient(seedClient)
	topic := createExportTopic(ctx, t, admin, 3)

	// 2^53 = 9007199254740992: every id is past the point where float64 loses
	// integers, so a lossy decode cannot produce a matching file.
	baseTime := time.Date(2026, time.March, 1, 12, 0, 0, 0, time.UTC)
	records := make([]*kgo.Record, 0, 165)
	for i := range 150 {
		kind := "a"
		if i%2 == 1 {
			kind = "b"
		}
		records = append(records, &kgo.Record{
			Topic:     topic,
			Partition: int32(i % 3),
			Timestamp: baseTime.Add(time.Duration(i) * time.Second),
			Value:     fmt.Appendf(nil, `{"user_id":%d,"kind":%q}`, 9007199254740992+i, kind),
		})
	}
	for i := range 10 {
		records = append(records, &kgo.Record{Topic: topic, Partition: int32(i % 3), Timestamp: baseTime, Value: []byte(`{"other":1}`)})
	}
	for i := range 5 {
		records = append(records, &kgo.Record{Topic: topic, Partition: int32(i % 3), Timestamp: baseTime, Value: []byte("not json")})
	}
	results := seedClient.ProduceSync(ctx, records...)
	if err := results.FirstErr(); err != nil {
		t.Fatalf("produce: %v", err)
	}
	// ProduceSync reports results in completion order, not input order, so each
	// seed is read back from its own record.
	var seeds []exportSeed
	for _, result := range results {
		var payload struct {
			UserID json.Number `json:"user_id"`
			Kind   string      `json:"kind"`
		}
		decoder := json.NewDecoder(bytes.NewReader(result.Record.Value))
		decoder.UseNumber()
		if decoder.Decode(&payload) != nil || payload.UserID == "" {
			continue
		}
		seeds = append(seeds, exportSeed{
			partition: result.Record.Partition,
			offset:    result.Record.Offset,
			at:        result.Record.Timestamp,
			userID:    payload.UserID.String(),
			kind:      payload.Kind,
		})
	}
	if len(seeds) != 150 {
		t.Fatalf("seeded %d user records, want 150", len(seeds))
	}

	conn, err := New(ctx, config.ConnectionConfig{
		Type:        "kafka",
		KafkaConfig: &config.KafkaConfig{Brokers: []string{broker}},
	}, "")
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	defer conn.Close()

	pivot := baseTime.Add(75 * time.Second)
	scenarios := []struct {
		name    string
		filters []connector.FilterExpr
		want    func(exportSeed) bool
	}{
		{name: "whole topic", want: func(exportSeed) bool { return true }},
		{name: "one partition", filters: eqFilters("partition", "1"), want: func(s exportSeed) bool { return s.partition == 1 }},
		{name: "content filter", filters: eqFilters("match_field", "kind", "match_value", "a"), want: func(s exportSeed) bool { return s.kind == "a" }},
		{name: "oldest from offset", filters: eqFilters("order", "oldest", "from_offset", "20"), want: func(s exportSeed) bool { return s.offset >= 20 }},
		{name: "newest from offset", filters: eqFilters("from_offset", "20"), want: func(s exportSeed) bool { return s.offset <= 20 }},
		{name: "oldest from time", filters: eqFilters("order", "oldest", "from_timestamp", pivot.Format(time.RFC3339)), want: func(s exportSeed) bool { return !s.at.Before(pivot) }},
		{name: "newest from time", filters: eqFilters("from_timestamp", pivot.Format(time.RFC3339)), want: func(s exportSeed) bool { return !s.at.After(pivot) }},
		{name: "partition, time and filter together", filters: eqFilters("partition", "2", "order", "oldest", "from_timestamp", pivot.Format(time.RFC3339), "match_field", "kind", "match_value", "b"), want: func(s exportSeed) bool {
			return s.partition == 2 && !s.at.Before(pivot) && s.kind == "b"
		}},
	}
	for _, sc := range scenarios {
		t.Run(sc.name, func(t *testing.T) {
			var want []string
			for _, seed := range seeds {
				if sc.want(seed) {
					want = append(want, seed.userID)
				}
			}
			got := exportUserIDs(ctx, t, conn, topic, sc.filters, nil)
			slices.Sort(want)
			if !slices.Equal(got, want) {
				t.Fatalf("got %d ids, want %d\ngot  %v\nwant %v", len(got), len(want), got, want)
			}
		})
	}

	t.Run("progress counts offsets up to the snapshot total", func(t *testing.T) {
		var reports [][2]int64
		err := conn.ExportFields(ctx, topic, []string{"user_id"}, nil, func([]string) error { return nil }, func(read, total int64) {
			reports = append(reports, [2]int64{read, total})
		})
		if err != nil {
			t.Fatalf("export: %v", err)
		}
		// 150 user records, 10 without user_id, 5 text: every offset counts,
		// whether or not it became a row.
		if len(reports) < 2 || reports[0] != [2]int64{0, 165} {
			t.Fatalf("first report %v of %d, want [0 165] first", reports[:min(1, len(reports))], len(reports))
		}
		if last := reports[len(reports)-1]; last != [2]int64{165, 165} {
			t.Fatalf("last report %v, want [165 165]", last)
		}
		for i := 1; i < len(reports); i++ {
			if reports[i][0] < reports[i-1][0] {
				t.Fatalf("progress went backwards: %v", reports)
			}
		}
	})

	t.Run("partition filter narrows the total", func(t *testing.T) {
		var total int64
		err := conn.ExportFields(ctx, topic, []string{"user_id"}, eqFilters("partition", "1"), func([]string) error { return nil }, func(_, all int64) {
			total = all
		})
		if err != nil {
			t.Fatalf("export: %v", err)
		}
		if total != 55 {
			t.Fatalf("partition 1 total %d, want 55: 50 users, 3 without user_id, 2 text", total)
		}
	})

	t.Run("messages produced during the export are left out", func(t *testing.T) {
		extra := make([]*kgo.Record, 0, 20)
		for i := range 20 {
			extra = append(extra, &kgo.Record{Topic: topic, Partition: int32(i % 3), Value: fmt.Appendf(nil, `{"user_id":%d}`, i)})
		}
		producedExtra := false
		got := exportUserIDs(ctx, t, conn, topic, nil, func() {
			if !producedExtra {
				producedExtra = true
				if err := seedClient.ProduceSync(ctx, extra...).FirstErr(); err != nil {
					t.Errorf("produce during export: %v", err)
				}
			}
		})
		// The earlier scenarios' 150 ids, none of the 20 added mid-export.
		if len(got) != 150 {
			t.Fatalf("got %d ids, want 150", len(got))
		}
	})

	t.Run("cancelling stops the export and leaves the connector usable", func(t *testing.T) {
		cancelCtx, cancelExport := context.WithCancel(ctx)
		defer cancelExport()
		rows := 0
		err := conn.ExportFields(cancelCtx, topic, []string{"user_id"}, nil, func([]string) error {
			rows++
			if rows == 10 {
				cancelExport()
			}
			return nil
		}, nil)
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("err = %v, want context.Canceled", err)
		}
		if _, err := conn.GetData(ctx, topic, connector.DataOpts{Limit: 5}); err != nil {
			t.Fatalf("browse after cancel: %v", err)
		}
	})

	t.Run("aborted transaction and trailing markers do not hang the export", func(t *testing.T) {
		txTopic := createExportTopic(ctx, t, admin, 1)
		producer, err := kgo.NewClient(
			kgo.SeedBrokers(broker),
			kgo.TransactionalID(fmt.Sprintf("kizuna-export-qa-%d", time.Now().UnixNano())),
			kgo.DefaultProduceTopic(txTopic),
		)
		if err != nil {
			t.Fatalf("transactional client: %v", err)
		}
		defer producer.Close()
		runTransaction := func(first int, count int, commit kgo.TransactionEndTry) {
			if err := producer.BeginTransaction(); err != nil {
				t.Fatalf("begin: %v", err)
			}
			for i := first; i < first+count; i++ {
				if err := producer.ProduceSync(ctx, &kgo.Record{Value: fmt.Appendf(nil, `{"user_id":%d}`, i)}).FirstErr(); err != nil {
					t.Fatalf("produce in transaction: %v", err)
				}
			}
			if err := producer.EndTransaction(ctx, commit); err != nil {
				t.Fatalf("end transaction: %v", err)
			}
		}
		runTransaction(0, 10, kgo.TryCommit)
		runTransaction(100, 5, kgo.TryAbort)

		got := exportUserIDs(ctx, t, conn, txTopic, nil, nil)
		want := []string{"0", "1", "2", "3", "4", "5", "6", "7", "8", "9"}
		if !slices.Equal(got, want) {
			t.Fatalf("got %v, want %v", got, want)
		}
	})
}

func createExportTopic(ctx context.Context, t *testing.T, admin *kadm.Client, partitions int32) string {
	t.Helper()
	topic := fmt.Sprintf("kizuna-export-qa-%d", time.Now().UnixNano())
	created, err := admin.CreateTopics(ctx, partitions, 1, nil, topic)
	if err != nil {
		t.Fatalf("create topic: %v", err)
	}
	if response := created[topic]; response.Err != nil {
		t.Fatalf("create topic response: %v", response.Err)
	}
	t.Cleanup(func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cleanupCancel()
		_, _ = admin.DeleteTopics(cleanupCtx, topic)
	})
	return topic
}

// eqFilters builds the FilterExpr list the browse sends, from column/value pairs.
func eqFilters(pairs ...string) []connector.FilterExpr {
	filters := make([]connector.FilterExpr, 0, len(pairs)/2)
	for i := 0; i+1 < len(pairs); i += 2 {
		filters = append(filters, connector.FilterExpr{Column: pairs[i], Op: "eq", Value: pairs[i+1]})
	}
	return filters
}

// exportUserIDs exports the user_id column and returns it sorted. onRow, when
// set, runs before each row is collected.
func exportUserIDs(ctx context.Context, t *testing.T, conn *KafkaConnector, topic string, filters []connector.FilterExpr, onRow func()) []string {
	t.Helper()
	var ids []string
	err := conn.ExportFields(ctx, topic, []string{"user_id"}, filters, func(cells []string) error {
		if onRow != nil {
			onRow()
		}
		ids = append(ids, cells[0])
		return nil
	}, nil)
	if err != nil {
		t.Fatalf("export: %v", err)
	}
	slices.Sort(ids)
	return ids
}
