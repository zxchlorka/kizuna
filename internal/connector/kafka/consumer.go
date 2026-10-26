package kafka

import (
	"context"
	"fmt"

	"github.com/twmb/franz-go/pkg/kadm"
	"github.com/zxchlorka/kizuna/internal/connector"
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

var _ connector.KafkaOffsetResetter = (*KafkaConnector)(nil)

// ResetGroupOffsets commits new offsets for one topic on behalf of a consumer
// group. Kafka only accepts such a commit from outside the group while the group
// has no members, so a live group is refused up front with the member count,
// which says more than the broker's UNKNOWN_MEMBER_ID would.
func (c *KafkaConnector) ResetGroupOffsets(ctx context.Context, req connector.KafkaOffsetResetRequest) (*connector.KafkaOffsetResetResult, error) {
	if c.config.ReadOnly {
		return nil, connector.ErrReadOnly
	}
	if req.Group == "" || req.Topic == "" {
		return nil, fmt.Errorf("%w: group and topic are required", connector.ErrBadRequest)
	}
	switch {
	case req.Mode != "earliest" && req.Mode != "latest" && req.Mode != "timestamp":
		return nil, fmt.Errorf("%w: unknown reset mode %q", connector.ErrBadRequest, req.Mode)
	case req.Mode == "timestamp" && req.Timestamp <= 0:
		return nil, fmt.Errorf("%w: timestamp is required", connector.ErrBadRequest)
	}

	ctx, cancel := context.WithTimeout(ctx, metadataTimeout)
	defer cancel()

	described, err := c.admin.DescribeGroups(ctx, req.Group)
	if err != nil {
		return nil, normalizeKafkaError(err)
	}
	if group, ok := described[req.Group]; ok {
		if group.Err != nil {
			return nil, normalizeKafkaError(group.Err)
		}
		if n := len(group.Members); n > 0 {
			return nil, fmt.Errorf("%w: group %q has %d active member(s); stop its consumers before resetting offsets",
				connector.ErrConflict, req.Group, n)
		}
	}

	var listed kadm.ListedOffsets
	switch req.Mode {
	case "earliest":
		listed, err = c.admin.ListStartOffsets(ctx, req.Topic)
	case "latest":
		listed, err = c.admin.ListEndOffsets(ctx, req.Topic)
	default: // "timestamp"
		// A partition with nothing at or after the instant comes back as its end
		// offset, so the group simply waits there for new records.
		listed, err = c.admin.ListOffsetsAfterMilli(ctx, req.Timestamp, req.Topic)
	}
	if err != nil {
		return nil, normalizeKafkaError(err)
	}
	if err := listed.Error(); err != nil {
		return nil, normalizeKafkaError(err)
	}
	if len(listed[req.Topic]) == 0 {
		return nil, fmt.Errorf("%w: topic %q", connector.ErrRelationNotFound, req.Topic)
	}

	if err := c.admin.CommitAllOffsets(ctx, req.Group, listed.Offsets()); err != nil {
		return nil, normalizeKafkaError(err)
	}

	partitions := listed[req.Topic]
	result := &connector.KafkaOffsetResetResult{Partitions: make([]connector.KafkaPartitionOffset, 0, len(partitions))}
	for _, id := range sortedPartitionIDs(partitions) {
		result.Partitions = append(result.Partitions, connector.KafkaPartitionOffset{Partition: id, Offset: partitions[id].Offset})
	}
	return result, nil
}
