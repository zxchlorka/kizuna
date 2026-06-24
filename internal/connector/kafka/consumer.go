package kafka

import (
	"context"

	"github.com/qsnake66/kizuna/internal/connector"
	"github.com/twmb/franz-go/pkg/kadm"
)

type partitionLag struct {
	Partition     int32 `json:"partition"`
	CurrentOffset int64 `json:"current_offset"`
	EndOffset     int64 `json:"end_offset"`
	Lag           int64 `json:"lag"`
}

// topicConsumerGroups returns the consumer groups that have committed offsets
// for the topic, with per-partition lag. Groups that fail to describe or fetch
// are skipped rather than failing the whole topic view.
func (c *KafkaConnector) topicConsumerGroups(ctx context.Context, topic string, starts, ends kadm.ListedOffsets) ([]connector.Object, error) {
	listed, err := c.admin.ListGroups(ctx)
	if err != nil {
		return nil, normalizeKafkaError(err)
	}
	names := listed.Groups()
	if len(names) == 0 {
		return nil, nil
	}

	described, _ := c.admin.DescribeGroups(ctx, names...)

	objects := make([]connector.Object, 0)
	for _, name := range names {
		offsets, err := c.admin.FetchOffsets(ctx, name)
		if err != nil {
			continue
		}
		committed, ok := offsets[topic]
		if !ok || len(committed) == 0 {
			continue
		}

		lags := make([]partitionLag, 0, len(committed))
		var totalLag int64
		for _, id := range sortedPartitionIDs(committed) {
			response := committed[id]
			if response.Err != nil {
				continue
			}

			start, end := partitionOffsets(topic, id, starts, ends)
			current := response.At
			lag := end - current
			if current < 0 {
				// No commit for this partition yet: the group would start from
				// the beginning, so everything retained counts as lag.
				lag = end - start
			}
			if lag < 0 {
				lag = 0
			}

			lags = append(lags, partitionLag{
				Partition:     id,
				CurrentOffset: current,
				EndOffset:     end,
				Lag:           lag,
			})
			totalLag += lag
		}
		if len(lags) == 0 {
			continue
		}

		state := ""
		members := 0
		if group, ok := described[name]; ok && group.Err == nil {
			state = group.State
			members = len(group.Members)
		}

		objects = append(objects, connector.Object{
			Name:       name,
			Type:       "kafka_consumer_group",
			ParentName: topic,
			RowCount:   totalLag,
			Path:       topic + "@" + name,
			Meta: map[string]any{
				"state":      state,
				"members":    members,
				"partitions": lags,
			},
		})
	}

	return objects, nil
}
