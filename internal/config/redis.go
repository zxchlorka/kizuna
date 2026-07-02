package config

import "slices"

type RedisMode string

const (
	RedisModeStandalone RedisMode = "standalone"
	RedisModeCluster    RedisMode = "cluster"
	RedisModeSentinel   RedisMode = "sentinel"
)

// RedisConfig stores Redis-specific connection settings for all supported modes.
type RedisConfig struct {
	Mode          RedisMode `json:"mode"`
	Address       string    `json:"address,omitempty"`
	Addresses     []string  `json:"addresses,omitempty"`
	SentinelAddrs []string  `json:"sentinel_addrs,omitempty"`
	MasterName    string    `json:"master_name,omitempty"`
	Separator     string    `json:"separator,omitempty"`
	Database      int       `json:"database,omitempty"`
	Username      string    `json:"username,omitempty"`
	TLSEnabled    bool      `json:"tls_enabled,omitempty"`
}

// Clone returns a deep copy of the Redis config.
func (r *RedisConfig) Clone() *RedisConfig {
	if r == nil {
		return nil
	}

	clone := *r
	if r.Addresses != nil {
		clone.Addresses = slices.Clone(r.Addresses)
	}
	if r.SentinelAddrs != nil {
		clone.SentinelAddrs = slices.Clone(r.SentinelAddrs)
	}
	return &clone
}

// Normalize applies default values without mutating the receiver.
func (r RedisConfig) Normalize() RedisConfig {
	clone := r
	if clone.Mode == "" {
		clone.Mode = RedisModeStandalone
	}
	if clone.Separator == "" {
		clone.Separator = ":"
	}
	return clone
}
