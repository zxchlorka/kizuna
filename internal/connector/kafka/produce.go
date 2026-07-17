package kafka

import (
	"context"
	"fmt"
	"strconv"
	"time"

	"github.com/twmb/franz-go/pkg/kgo"
	"github.com/zxchlorka/kizuna/internal/connector"
)

const (
	maxProduceMessages = 10000
	produceTimeout     = 15 * time.Second
)

var _ connector.KafkaProducer = (*KafkaConnector)(nil)

// Produce publishes an already-expanded batch to one topic. The batch is built
// and expanded client-side (loop/multi templating); here we just publish.
func (c *KafkaConnector) Produce(ctx context.Context, req connector.KafkaProduceRequest) (*connector.KafkaProduceResult, error) {
	if c.config.ReadOnly {
		return nil, connector.ErrReadOnly
	}
	if req.Topic == "" {
		return nil, fmt.Errorf("%w: topic is required", connector.ErrBadRequest)
	}
	if len(req.Messages) == 0 {
		return nil, fmt.Errorf("%w: at least one message is required", connector.ErrBadRequest)
	}
	if len(req.Messages) > maxProduceMessages {
		return nil, fmt.Errorf("%w: too many messages (%d), limit is %d", connector.ErrBadRequest, len(req.Messages), maxProduceMessages)
	}
	if req.Partition != nil && *req.Partition < 0 {
		return nil, fmt.Errorf("%w: partition must be non-negative", connector.ErrBadRequest)
	}

	records := buildProduceRecords(req)

	// A dedicated short-lived client keeps produce state off the shared admin
	// client. The manual partitioner is only used when a partition is pinned;
	// otherwise the default partitioner hashes by key.
	opts, err := buildClientOpts(c.settings)
	if err != nil {
		return nil, err
	}
	if req.Partition != nil {
		opts = append(opts, kgo.RecordPartitioner(kgo.ManualPartitioner()))
	}

	client, err := kgo.NewClient(opts...)
	if err != nil {
		return nil, fmt.Errorf("failed to create kafka producer: %w", err)
	}
	defer client.Close()

	produceCtx, cancel := context.WithTimeout(ctx, produceTimeout)
	defer cancel()

	results := client.ProduceSync(produceCtx, records...)

	result := &connector.KafkaProduceResult{Partitions: map[string]int{}}
	for _, r := range results {
		if r.Err != nil {
			result.Failed++
			if len(result.Errors) < 10 {
				result.Errors = append(result.Errors, normalizeKafkaError(r.Err).Error())
			}
			continue
		}
		result.Produced++
		if r.Record != nil {
			key := strconv.Itoa(int(r.Record.Partition))
			result.Partitions[key]++
		}
	}

	return result, nil
}

func buildProduceRecords(req connector.KafkaProduceRequest) []*kgo.Record {
	records := make([]*kgo.Record, 0, len(req.Messages))
	for _, message := range req.Messages {
		record := &kgo.Record{
			Topic: req.Topic,
			Value: []byte(message.Value),
		}
		if message.Key != "" {
			record.Key = []byte(message.Key)
		}
		if req.Partition != nil {
			record.Partition = *req.Partition
		}
		for name, value := range message.Headers {
			record.Headers = append(record.Headers, kgo.RecordHeader{Key: name, Value: []byte(value)})
		}
		records = append(records, record)
	}
	return records
}
