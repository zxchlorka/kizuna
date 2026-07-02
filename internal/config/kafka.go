package config

import (
	"slices"
	"strings"
)

const (
	KafkaSASLPlain       = "PLAIN"
	KafkaSASLScramSHA256 = "SCRAM-SHA-256"
	KafkaSASLScramSHA512 = "SCRAM-SHA-512"
)

// KafkaConfig stores Kafka-specific connection settings. Username and password
// live on the parent ConnectionConfig (password is encrypted there).
type KafkaConfig struct {
	Brokers           []string `json:"brokers"`
	SASLMechanism     string   `json:"sasl_mechanism,omitempty"` // "" (no auth) | PLAIN | SCRAM-SHA-256 | SCRAM-SHA-512
	TLSEnabled        bool     `json:"tls_enabled,omitempty"`
	SchemaRegistryURL string   `json:"schema_registry_url,omitempty"` // reserved for a future slice
}

// Clone returns a deep copy of the Kafka config.
func (k *KafkaConfig) Clone() *KafkaConfig {
	if k == nil {
		return nil
	}

	clone := *k
	if k.Brokers != nil {
		clone.Brokers = slices.Clone(k.Brokers)
	}
	return &clone
}

// Normalize trims broker entries and upper-cases the SASL mechanism without
// mutating the receiver.
func (k KafkaConfig) Normalize() KafkaConfig {
	clone := k
	brokers := make([]string, 0, len(k.Brokers))
	for _, broker := range k.Brokers {
		broker = strings.TrimSpace(broker)
		if broker != "" {
			brokers = append(brokers, broker)
		}
	}
	clone.Brokers = brokers
	clone.SASLMechanism = strings.ToUpper(strings.TrimSpace(k.SASLMechanism))
	return clone
}
