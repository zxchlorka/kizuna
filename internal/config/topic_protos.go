package config

import "slices"

// TopicProtoConfig is the .proto contract a user attached to a Kafka topic, so
// its binary values are shown as JSON. The source is kept whole: it is small,
// and compiling it again on load needs nothing outside the config.
type TopicProtoConfig struct {
	ConnID   string `json:"conn_id"`
	Topic    string `json:"topic"`
	FileName string `json:"file_name"`
	Source   string `json:"source"`
	Message  string `json:"message"`
}

func (c *AppConfig) GetTopicProto(connID, topic string) (TopicProtoConfig, bool) {
	c.mu.RLock()
	defer c.mu.RUnlock()
	for _, proto := range c.TopicProtos {
		if proto.ConnID == connID && proto.Topic == topic {
			return proto, true
		}
	}
	return TopicProtoConfig{}, false
}

// SetTopicProto attaches the contract to its topic, replacing the one there.
func (c *AppConfig) SetTopicProto(proto TopicProtoConfig) {
	c.mu.Lock()
	defer c.mu.Unlock()
	for i, existing := range c.TopicProtos {
		if existing.ConnID == proto.ConnID && existing.Topic == proto.Topic {
			c.TopicProtos[i] = proto
			return
		}
	}
	c.TopicProtos = append(c.TopicProtos, proto)
}

func (c *AppConfig) RemoveTopicProto(connID, topic string) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	before := len(c.TopicProtos)
	c.TopicProtos = slices.DeleteFunc(c.TopicProtos, func(proto TopicProtoConfig) bool {
		return proto.ConnID == connID && proto.Topic == topic
	})
	return len(c.TopicProtos) != before
}
