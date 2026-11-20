package kafka

import (
	"context"
	"os"
	"slices"
	"testing"
	"time"

	"github.com/twmb/franz-go/pkg/kadm"
	"github.com/twmb/franz-go/pkg/kgo"
	"github.com/zxchlorka/kizuna/internal/config"
	"github.com/zxchlorka/kizuna/internal/connector"
	"github.com/zxchlorka/kizuna/internal/protoschema"
	"google.golang.org/protobuf/encoding/protowire"
)

// A topic where protobuf, JSON and stray bytes are mixed, as in real topics
// that changed format at some point. Browse, search and export must read the
// protobuf ones through the contract and leave the rest as they were.
func TestProtoTopicIntegration(t *testing.T) {
	broker := os.Getenv("KAFKA_TEST_BROKER")
	if broker == "" {
		t.Skip("set KAFKA_TEST_BROKER to run the local Kafka integration test")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	schema, err := protoschema.Compile(ctx, "event.proto", `syntax = "proto3";
package demo.v1;
message Item { int64 id = 1; }
message Event {
  int64 user_id = 1;
  repeated Item items = 2;
}
`)
	if err != nil {
		t.Fatal(err)
	}
	decoder, err := schema.Decoder("demo.v1.Event")
	if err != nil {
		t.Fatal(err)
	}

	event := func(userID uint64, items ...uint64) []byte {
		var b []byte
		b = protowire.AppendTag(b, 1, protowire.VarintType)
		b = protowire.AppendVarint(b, userID)
		for _, id := range items {
			var item []byte
			item = protowire.AppendTag(item, 1, protowire.VarintType)
			item = protowire.AppendVarint(item, id)
			b = protowire.AppendTag(b, 2, protowire.BytesType)
			b = protowire.AppendBytes(b, item)
		}
		return b
	}

	seedClient, err := kgo.NewClient(kgo.SeedBrokers(broker))
	if err != nil {
		t.Fatal(err)
	}
	defer seedClient.Close()
	topic := createExportTopic(ctx, t, kadm.NewClient(seedClient), 1)
	values := [][]byte{
		event(9007199254740993, 1, 2),
		event(42),
		[]byte(`{"user_id":7}`),
		{0xff, 0xfe, 0xfd},
		event(9007199254740993),
	}
	for _, value := range values {
		if err := seedClient.ProduceSync(ctx, &kgo.Record{Topic: topic, Value: value}).FirstErr(); err != nil {
			t.Fatalf("produce: %v", err)
		}
	}

	conn, err := New(ctx, config.ConnectionConfig{Type: "kafka", KafkaConfig: &config.KafkaConfig{Brokers: []string{broker}}}, "")
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()

	t.Run("browse", func(t *testing.T) {
		result, err := conn.GetData(ctx, topic, connector.DataOpts{Limit: 10, Filters: eqFilters("order", "oldest"), ValueDecoder: decoder})
		if err != nil {
			t.Fatal(err)
		}
		var got []string
		for _, row := range result.Rows {
			got = append(got, row["format"].(string)+" "+row["value"].(string))
		}
		want := []string{
			`protobuf {"user_id":9007199254740993,"items":[{"id":1},{"id":2}]}`,
			`protobuf {"user_id":42}`,
			`json {"user_id":7}`,
			`binary //79`,
			`protobuf {"user_id":9007199254740993}`,
		}
		if !slices.Equal(got, want) {
			t.Fatalf("rows\n got %q\nwant %q", got, want)
		}
	})

	t.Run("search", func(t *testing.T) {
		filters := eqFilters("order", "oldest", "match_field", "user_id", "match_value", "9007199254740993")
		result, err := conn.GetData(ctx, topic, connector.DataOpts{Limit: 10, Filters: filters, ValueDecoder: decoder})
		if err != nil {
			t.Fatal(err)
		}
		if len(result.Rows) != 2 {
			t.Fatalf("matched %d rows, want the two protobuf messages of that user", len(result.Rows))
		}
	})

	t.Run("export", func(t *testing.T) {
		var rows []string
		err := conn.ExportFields(ctx, topic, []string{"user_id", "items[].id"}, nil, decoder, func(cells []string) error {
			rows = append(rows, cells[0]+"|"+cells[1])
			return nil
		}, nil)
		if err != nil {
			t.Fatal(err)
		}
		slices.Sort(rows)
		want := []string{"42|", "7|", "9007199254740993|", "9007199254740993|[1,2]"}
		if !slices.Equal(rows, want) {
			t.Fatalf("rows %q, want %q", rows, want)
		}
	})
}
