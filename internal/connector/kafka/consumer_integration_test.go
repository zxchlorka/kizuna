package kafka

import (
	"context"
	"errors"
	"fmt"
	"os"
	"testing"
	"time"

	"github.com/twmb/franz-go/pkg/kadm"
	"github.com/twmb/franz-go/pkg/kgo"
	"github.com/zxchlorka/kizuna/internal/config"
	"github.com/zxchlorka/kizuna/internal/connector"
)

func TestResetGroupOffsetsIntegration(t *testing.T) {
	broker := os.Getenv("KAFKA_TEST_BROKER")
	if broker == "" {
		t.Skip("set KAFKA_TEST_BROKER to run the local Kafka offset reset test")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	seed, err := kgo.NewClient(kgo.SeedBrokers(broker), kgo.RecordPartitioner(kgo.ManualPartitioner()))
	if err != nil {
		t.Fatalf("create seed client: %v", err)
	}
	// Cleanup, not defer: deleting the topic and group below needs the client open.
	t.Cleanup(seed.Close)
	admin := kadm.NewClient(seed)

	topic := fmt.Sprintf("kizuna-reset-qa-%d", time.Now().UnixNano())
	group := topic + "-group"
	if _, err := admin.CreateTopics(ctx, 2, 1, nil, topic); err != nil {
		t.Fatalf("create topic: %v", err)
	}
	t.Cleanup(func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cleanupCancel()
		_, _ = admin.DeleteGroups(cleanupCtx, group)
		_, _ = admin.DeleteTopics(cleanupCtx, topic)
	})

	// Five records per partition, one second apart: offset i was written at base+i s.
	base := time.Date(2026, time.March, 1, 12, 0, 0, 0, time.UTC)
	var records []*kgo.Record
	for partition := int32(0); partition < 2; partition++ {
		for i := 0; i < 5; i++ {
			records = append(records, &kgo.Record{Topic: topic, Partition: partition, Timestamp: base.Add(time.Duration(i) * time.Second), Value: []byte("{}")})
		}
	}
	if err := seed.ProduceSync(ctx, records...).FirstErr(); err != nil {
		t.Fatalf("produce: %v", err)
	}

	conn, err := New(ctx, config.ConnectionConfig{Type: "kafka", KafkaConfig: &config.KafkaConfig{Brokers: []string{broker}}}, "")
	if err != nil {
		t.Fatalf("create connector: %v", err)
	}
	defer conn.Close()
	var resetter connector.KafkaOffsetResetter = conn

	committed := func() map[int32]int64 {
		fetched, err := admin.FetchOffsets(ctx, group)
		if err != nil {
			t.Fatalf("fetch offsets: %v", err)
		}
		out := map[int32]int64{}
		for id, o := range fetched[topic] {
			out[id] = o.At
		}
		return out
	}

	tests := []struct {
		name string
		req  connector.KafkaOffsetResetRequest
		want map[int32]int64
	}{
		{"latest on a group with no commits yet", connector.KafkaOffsetResetRequest{Mode: "latest"}, map[int32]int64{0: 5, 1: 5}},
		{"earliest", connector.KafkaOffsetResetRequest{Mode: "earliest"}, map[int32]int64{0: 0, 1: 0}},
		{"timestamp lands on the first record at or after it", connector.KafkaOffsetResetRequest{Mode: "timestamp", Timestamp: base.Add(2500 * time.Millisecond).UnixMilli()}, map[int32]int64{0: 3, 1: 3}},
		{"timestamp past the end parks at the end", connector.KafkaOffsetResetRequest{Mode: "timestamp", Timestamp: base.Add(time.Hour).UnixMilli()}, map[int32]int64{0: 5, 1: 5}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			tt.req.Group, tt.req.Topic = group, topic
			result, err := resetter.ResetGroupOffsets(ctx, tt.req)
			if err != nil {
				t.Fatalf("reset: %v", err)
			}
			if len(result.Partitions) != 2 {
				t.Fatalf("result partitions = %v", result.Partitions)
			}
			got := committed()
			for id, want := range tt.want {
				if got[id] != want {
					t.Fatalf("partition %d committed %d, want %d (all: %v)", id, got[id], want, got)
				}
			}
		})
	}

	t.Run("refuses a group with live members", func(t *testing.T) {
		member, err := kgo.NewClient(kgo.SeedBrokers(broker), kgo.ConsumerGroup(group), kgo.ConsumeTopics(topic))
		if err != nil {
			t.Fatalf("create member: %v", err)
		}
		defer member.Close()

		deadline := time.Now().Add(30 * time.Second)
		for {
			pollCtx, pollCancel := context.WithTimeout(ctx, time.Second)
			member.PollFetches(pollCtx)
			pollCancel()
			described, err := admin.DescribeGroups(ctx, group)
			if err == nil && len(described[group].Members) > 0 {
				break
			}
			if time.Now().After(deadline) {
				t.Fatal("consumer never joined the group")
			}
		}

		_, err = resetter.ResetGroupOffsets(ctx, connector.KafkaOffsetResetRequest{Group: group, Topic: topic, Mode: "earliest"})
		if !errors.Is(err, connector.ErrConflict) {
			t.Fatalf("err = %v, want ErrConflict", err)
		}
	})

	t.Run("rejects bad input before touching the broker", func(t *testing.T) {
		for _, req := range []connector.KafkaOffsetResetRequest{
			{Topic: topic, Mode: "earliest"},
			{Group: group, Topic: topic, Mode: "sideways"},
			{Group: group, Topic: topic, Mode: "timestamp"},
		} {
			if _, err := resetter.ResetGroupOffsets(ctx, req); !errors.Is(err, connector.ErrBadRequest) {
				t.Fatalf("%+v: err = %v, want ErrBadRequest", req, err)
			}
		}
	})
}
