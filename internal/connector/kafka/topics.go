package kafka

import (
	"context"
	"fmt"
	"sort"
	"strconv"

	"github.com/twmb/franz-go/pkg/kadm"
	"github.com/twmb/franz-go/pkg/kmsg"
	"github.com/zxchlorka/kizuna/internal/connector"
)

func (c *KafkaConnector) ListObjects(ctx context.Context, path string) ([]connector.Object, error) {
	ctx, cancel := context.WithTimeout(ctx, metadataTimeout)
	defer cancel()

	if path == "" {
		return c.listTopics(ctx)
	}
	return c.listTopicChildren(ctx, path)
}

func (c *KafkaConnector) listTopics(ctx context.Context) ([]connector.Object, error) {
	topics, err := c.admin.ListTopics(ctx)
	if err != nil {
		return nil, normalizeKafkaError(err)
	}

	objects := make([]connector.Object, 0, len(topics))
	for _, detail := range topics.Sorted() {
		if detail.Err != nil {
			continue
		}

		objects = append(objects, connector.Object{
			Name:     detail.Topic,
			Type:     "kafka_topic",
			RowCount: 0,
			Path:     detail.Topic,
			Meta: map[string]any{
				"partitions":   len(detail.Partitions),
				"replication":  topicReplicationFactor(detail),
				"count_status": "not_loaded",
			},
		})
	}

	return objects, nil
}

// listTopicChildren returns the topic's partitions followed by the consumer
// groups that have committed offsets for it — the topic view renders both
// from this single response.
func (c *KafkaConnector) listTopicChildren(ctx context.Context, topic string) ([]connector.Object, error) {
	topics, err := c.admin.ListTopics(ctx, topic)
	if err != nil {
		return nil, normalizeKafkaError(err)
	}
	detail, ok := topics[topic]
	if !ok || detail.Err != nil {
		return nil, fmt.Errorf("%w: topic %q not found", connector.ErrRelationNotFound, topic)
	}

	starts, err := c.admin.ListStartOffsets(ctx, topic)
	if err != nil {
		return nil, normalizeKafkaError(err)
	}
	ends, err := c.admin.ListEndOffsets(ctx, topic)
	if err != nil {
		return nil, normalizeKafkaError(err)
	}

	partitionIDs := sortedPartitionIDs(detail.Partitions)
	objects := make([]connector.Object, 0, len(partitionIDs))
	for _, id := range partitionIDs {
		partition := detail.Partitions[id]
		start, end := partitionOffsets(topic, id, starts, ends)

		objects = append(objects, connector.Object{
			Name:       strconv.Itoa(int(id)),
			Type:       "kafka_partition",
			ParentName: topic,
			RowCount:   maxInt64(0, end-start),
			Path:       topic + "/" + strconv.Itoa(int(id)),
			Meta: map[string]any{
				"leader":       partition.Leader,
				"replicas":     len(partition.Replicas),
				"isr":          len(partition.ISR),
				"start_offset": start,
				"end_offset":   end,
			},
		})
	}

	groups, err := c.topicConsumerGroups(ctx, topic, starts, ends)
	if err != nil {
		return nil, err
	}

	return append(objects, groups...), nil
}

func topicReplicationFactor(detail kadm.TopicDetail) int {
	for _, partition := range detail.Partitions {
		return len(partition.Replicas)
	}
	return 0
}

func topicMessageEstimate(topic string, partitionIDs []int32, starts, ends kadm.ListedOffsets) int64 {
	var total int64
	for _, id := range partitionIDs {
		start, end := partitionOffsets(topic, id, starts, ends)
		total += maxInt64(0, end-start)
	}
	return total
}

func partitionOffsets(topic string, partition int32, starts, ends kadm.ListedOffsets) (int64, int64) {
	var start, end int64
	if listed, ok := starts.Lookup(topic, partition); ok && listed.Err == nil {
		start = listed.Offset
	}
	if listed, ok := ends.Lookup(topic, partition); ok && listed.Err == nil {
		end = listed.Offset
	}
	return start, end
}

func maxInt64(left, right int64) int64 {
	if left > right {
		return left
	}
	return right
}

// topicConfig is one broker-reported setting. Source is carried because it
// answers the question a raw value cannot: whether somebody set this on the
// topic or whether it is just the broker default showing through.
type topicConfig struct {
	Key    string `json:"key"`
	Value  string `json:"value"`
	Source string `json:"source"`
	// SetOnTopic is true when the value comes from the topic's own config
	// rather than from a broker or static default.
	SetOnTopic bool `json:"set_on_topic"`
}

func (c *KafkaConnector) topicSchema(ctx context.Context, topic string) (*connector.Schema, error) {
	ctx, cancel := context.WithTimeout(ctx, metadataTimeout)
	defer cancel()

	topics, err := c.admin.ListTopics(ctx, topic)
	if err != nil {
		return nil, normalizeKafkaError(err)
	}
	detail, ok := topics[topic]
	if !ok || detail.Err != nil {
		return nil, fmt.Errorf("%w: topic %q not found", connector.ErrRelationNotFound, topic)
	}

	resources, err := c.admin.DescribeTopicConfigs(ctx, topic)
	if err != nil {
		return nil, normalizeKafkaError(err)
	}
	resource, err := resources.On(topic, nil)
	if err != nil {
		return nil, normalizeKafkaError(err)
	}
	if resource.Err != nil {
		return nil, normalizeKafkaError(resource.Err)
	}

	configs := make([]topicConfig, 0, len(resource.Configs))
	for _, config := range resource.Configs {
		// A sensitive config comes back with a nil value; listing the key with
		// an empty value would read as "set to nothing" rather than "withheld".
		if config.Sensitive {
			continue
		}
		configs = append(configs, topicConfig{
			Key:        config.Key,
			Value:      config.MaybeValue(),
			Source:     configSourceName(config.Source),
			SetOnTopic: config.Source == kmsg.ConfigSourceDynamicTopicConfig,
		})
	}
	sort.Slice(configs, func(i, j int) bool { return configs[i].Key < configs[j].Key })

	return &connector.Schema{
		ObjectType: "kafka_topic",
		Columns:    []connector.ColumnMeta{},
		Meta: map[string]any{
			"partitions":  len(detail.Partitions),
			"replication": topicReplicationFactor(detail),
			"configs":     configs,
		},
	}, nil
}

func configSourceName(source kmsg.ConfigSource) string {
	switch source {
	case kmsg.ConfigSourceDynamicTopicConfig:
		return "topic"
	case kmsg.ConfigSourceDynamicBrokerConfig:
		return "broker"
	case kmsg.ConfigSourceDynamicDefaultBrokerConfig:
		return "broker default"
	case kmsg.ConfigSourceStaticBrokerConfig:
		return "static broker"
	case kmsg.ConfigSourceDefaultConfig:
		return "default"
	default:
		return "unknown"
	}
}
