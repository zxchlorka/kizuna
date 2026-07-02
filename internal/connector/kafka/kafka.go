package kafka

import (
	"context"
	"crypto/tls"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"sort"
	"strings"
	"time"

	"github.com/qsnake66/kizuna/internal/config"
	"github.com/qsnake66/kizuna/internal/connector"
	"github.com/twmb/franz-go/pkg/kadm"
	"github.com/twmb/franz-go/pkg/kerr"
	"github.com/twmb/franz-go/pkg/kgo"
	"github.com/twmb/franz-go/pkg/sasl/plain"
	"github.com/twmb/franz-go/pkg/sasl/scram"
)

const (
	pingTimeout     = 5 * time.Second
	metadataTimeout = 10 * time.Second
)

type kafkaSettings struct {
	brokers       []string
	saslMechanism string
	username      string
	password      string
	tlsEnabled    bool
}

type KafkaConnector struct {
	client   *kgo.Client
	admin    *kadm.Client
	config   config.ConnectionConfig
	settings kafkaSettings
}

// New creates a KafkaConnector and verifies broker reachability.
func New(ctx context.Context, cfg config.ConnectionConfig, encKey string) (*KafkaConnector, error) {
	settings, err := resolveKafkaSettings(cfg, encKey)
	if err != nil {
		return nil, err
	}

	opts, err := buildClientOpts(settings)
	if err != nil {
		return nil, err
	}

	client, err := kgo.NewClient(opts...)
	if err != nil {
		return nil, fmt.Errorf("failed to create kafka client: %w", err)
	}

	conn := &KafkaConnector{
		client:   client,
		admin:    kadm.NewClient(client),
		config:   cfg,
		settings: settings,
	}

	if err := conn.Ping(ctx); err != nil {
		client.Close()
		return nil, fmt.Errorf("failed to ping kafka: %w", err)
	}

	slog.Info("kafka connector created",
		"brokers", settings.brokers,
		"sasl", settings.saslMechanism,
		"tls", settings.tlsEnabled,
	)

	return conn, nil
}

// NewFactory returns a ConnectorFactory for Kafka.
func NewFactory() connector.ConnectorFactory {
	return func(ctx context.Context, cfg config.ConnectionConfig, encKey string) (connector.Connector, error) {
		return New(ctx, cfg, encKey)
	}
}

func resolveKafkaSettings(cfg config.ConnectionConfig, encKey string) (kafkaSettings, error) {
	kafkaCfg := config.KafkaConfig{}
	if cfg.KafkaConfig != nil {
		kafkaCfg = *cfg.KafkaConfig
	}
	kafkaCfg = kafkaCfg.Normalize()

	brokers := resolveKafkaBrokers(kafkaCfg.Brokers)
	if len(brokers) == 0 && cfg.Host != "" {
		port := cfg.Port
		if port <= 0 {
			port = 9092
		}
		brokers = resolveKafkaBrokers([]string{net.JoinHostPort(cfg.Host, fmt.Sprint(port))})
	}
	if len(brokers) == 0 {
		return kafkaSettings{}, fmt.Errorf("%w: kafka connection requires at least one broker", connector.ErrBadRequest)
	}

	password, err := decryptPassword(encKey, cfg.Password)
	if err != nil {
		return kafkaSettings{}, fmt.Errorf("failed to decrypt password: %w", err)
	}

	settings := kafkaSettings{
		brokers:       brokers,
		saslMechanism: kafkaCfg.SASLMechanism,
		username:      strings.TrimSpace(cfg.Username),
		password:      password,
		tlsEnabled:    kafkaCfg.TLSEnabled,
	}

	switch settings.saslMechanism {
	case "", config.KafkaSASLPlain, config.KafkaSASLScramSHA256, config.KafkaSASLScramSHA512:
	default:
		return kafkaSettings{}, fmt.Errorf("%w: unsupported sasl mechanism %q", connector.ErrBadRequest, settings.saslMechanism)
	}
	if settings.saslMechanism != "" && settings.username == "" {
		return kafkaSettings{}, fmt.Errorf("%w: sasl authentication requires a username", connector.ErrBadRequest)
	}

	return settings, nil
}

func buildClientOpts(settings kafkaSettings) ([]kgo.Opt, error) {
	opts := []kgo.Opt{
		kgo.SeedBrokers(settings.brokers...),
	}

	switch settings.saslMechanism {
	case "":
	case config.KafkaSASLPlain:
		opts = append(opts, kgo.SASL(plain.Auth{User: settings.username, Pass: settings.password}.AsMechanism()))
	case config.KafkaSASLScramSHA256:
		opts = append(opts, kgo.SASL(scram.Auth{User: settings.username, Pass: settings.password}.AsSha256Mechanism()))
	case config.KafkaSASLScramSHA512:
		opts = append(opts, kgo.SASL(scram.Auth{User: settings.username, Pass: settings.password}.AsSha512Mechanism()))
	default:
		return nil, fmt.Errorf("%w: unsupported sasl mechanism %q", connector.ErrBadRequest, settings.saslMechanism)
	}

	if settings.tlsEnabled {
		opts = append(opts, kgo.DialTLSConfig(&tls.Config{MinVersion: tls.VersionTLS12}))
	}

	return opts, nil
}

func resolveKafkaBrokers(brokers []string) []string {
	seen := make(map[string]struct{}, len(brokers))
	out := make([]string, 0, len(brokers))
	for _, broker := range brokers {
		broker = strings.TrimSpace(broker)
		if broker == "" {
			continue
		}
		if _, ok := seen[broker]; ok {
			continue
		}
		seen[broker] = struct{}{}
		out = append(out, broker)
	}
	return out
}

func decryptPassword(encKey, password string) (string, error) {
	if encKey == "" || password == "" {
		return password, nil
	}
	return config.Decrypt(encKey, password)
}

func (c *KafkaConnector) Ping(ctx context.Context) error {
	ctx, cancel := context.WithTimeout(ctx, pingTimeout)
	defer cancel()

	_, err := c.admin.BrokerMetadata(ctx)
	return normalizeKafkaError(err)
}

func (c *KafkaConnector) GetInfo(ctx context.Context) (*connector.ConnInfo, error) {
	ctx, cancel := context.WithTimeout(ctx, metadataTimeout)
	defer cancel()

	meta, err := c.admin.BrokerMetadata(ctx)
	if err != nil {
		return nil, fmt.Errorf("failed to get kafka metadata: %w", normalizeKafkaError(err))
	}

	host, port := "", ""
	if len(c.settings.brokers) > 0 {
		host, port = splitBrokerAddress(c.settings.brokers[0])
	}

	extra := map[string]any{
		"cluster_id":   meta.Cluster,
		"controller":   meta.Controller,
		"broker_count": len(meta.Brokers),
		"sasl":         c.settings.saslMechanism,
		"tls_enabled":  c.settings.tlsEnabled,
	}

	return &connector.ConnInfo{
		Version:  c.guessBrokerVersion(ctx),
		Database: meta.Cluster,
		Host:     host,
		Port:     port,
		Extra:    extra,
	}, nil
}

func (c *KafkaConnector) guessBrokerVersion(ctx context.Context) string {
	versions, err := c.admin.ApiVersions(ctx)
	if err != nil {
		return ""
	}
	for _, broker := range versions {
		if broker.Err != nil {
			continue
		}
		return broker.VersionGuess()
	}
	return ""
}

func (c *KafkaConnector) Close() error {
	if c.client != nil {
		c.client.Close()
	}
	return nil
}

func unsupportedKafkaOperation(name string) error {
	return fmt.Errorf("%w: kafka %s is not supported yet", connector.ErrBadRequest, name)
}

func (c *KafkaConnector) GetSchema(context.Context, string) (*connector.Schema, error) {
	return nil, unsupportedKafkaOperation("schema")
}

func (c *KafkaConnector) GetObjectInfo(context.Context, string) (*connector.ObjectInfo, error) {
	return nil, unsupportedKafkaOperation("object info")
}

func (c *KafkaConnector) Execute(context.Context, string) (*connector.ExecResult, error) {
	return nil, unsupportedKafkaOperation("execute")
}

func (c *KafkaConnector) ExecuteBatch(context.Context, []string) ([]connector.ExecResult, error) {
	return nil, unsupportedKafkaOperation("execute")
}

func (c *KafkaConnector) Explain(context.Context, string) (*connector.ExplainResult, error) {
	return nil, unsupportedKafkaOperation("explain")
}

func (c *KafkaConnector) Analyze(context.Context, string) (*connector.ExplainResult, error) {
	return nil, unsupportedKafkaOperation("analyze")
}

func (c *KafkaConnector) Completions(context.Context, connector.CompletionRequest) ([]connector.CompletionItem, error) {
	return nil, unsupportedKafkaOperation("completions")
}

func (c *KafkaConnector) Mutate(context.Context, connector.MutateOp) (*connector.MutateResult, error) {
	return nil, unsupportedKafkaOperation("mutate")
}

func (c *KafkaConnector) MutateBulk(context.Context, connector.BulkMutateOp) (*connector.BulkMutateResult, error) {
	return nil, unsupportedKafkaOperation("bulk mutate")
}

func (c *KafkaConnector) DDL(context.Context, connector.DDLOp) error {
	return unsupportedKafkaOperation("ddl")
}

func splitBrokerAddress(addr string) (string, string) {
	host, port, err := net.SplitHostPort(addr)
	if err != nil {
		return addr, ""
	}
	return host, port
}

func normalizeKafkaError(err error) error {
	if err == nil {
		return nil
	}

	if errors.Is(err, context.DeadlineExceeded) || errors.Is(err, context.Canceled) {
		return fmt.Errorf("%w: %s", connector.ErrTimeout, err.Error())
	}

	var kafkaErr *kerr.Error
	if errors.As(err, &kafkaErr) {
		switch kafkaErr.Code {
		case kerr.SaslAuthenticationFailed.Code,
			kerr.TopicAuthorizationFailed.Code,
			kerr.GroupAuthorizationFailed.Code,
			kerr.ClusterAuthorizationFailed.Code:
			return fmt.Errorf("%w: %s", connector.ErrForbidden, err.Error())
		case kerr.UnknownTopicOrPartition.Code:
			return fmt.Errorf("%w: %s", connector.ErrRelationNotFound, err.Error())
		case kerr.RequestTimedOut.Code:
			return fmt.Errorf("%w: %s", connector.ErrTimeout, err.Error())
		}
	}

	var opErr *net.OpError
	if errors.As(err, &opErr) {
		return fmt.Errorf("%w: %s", connector.ErrUnavailable, err.Error())
	}

	msg := strings.ToLower(err.Error())
	switch {
	case strings.Contains(msg, "sasl"),
		strings.Contains(msg, "authentication"),
		strings.Contains(msg, "authorization"):
		return fmt.Errorf("%w: %s", connector.ErrForbidden, err.Error())
	case strings.Contains(msg, "deadline"),
		strings.Contains(msg, "timeout"):
		return fmt.Errorf("%w: %s", connector.ErrTimeout, err.Error())
	case strings.Contains(msg, "connection refused"),
		strings.Contains(msg, "no such host"),
		strings.Contains(msg, "broken pipe"),
		strings.Contains(msg, "unable to dial"),
		strings.Contains(msg, "network is unreachable"):
		return fmt.Errorf("%w: %s", connector.ErrUnavailable, err.Error())
	default:
		return err
	}
}

func sortedPartitionIDs[V any](partitions map[int32]V) []int32 {
	ids := make([]int32, 0, len(partitions))
	for id := range partitions {
		ids = append(ids, id)
	}
	sort.Slice(ids, func(i, j int) bool { return ids[i] < ids[j] })
	return ids
}
