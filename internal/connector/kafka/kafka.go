package kafka

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/twmb/franz-go/pkg/kadm"
	"github.com/twmb/franz-go/pkg/kerr"
	"github.com/twmb/franz-go/pkg/kgo"
	"github.com/twmb/franz-go/pkg/sasl/plain"
	"github.com/twmb/franz-go/pkg/sasl/scram"
	"github.com/zxchlorka/kizuna/internal/config"
	"github.com/zxchlorka/kizuna/internal/connector"
)

const (
	pingTimeout     = 5 * time.Second
	metadataTimeout = 10 * time.Second

	// fetchMaxWait bounds how long a broker holds a single fetch waiting for more
	// records. Kept well below the reader's overall readBudget (see messages.go)
	// so the poll loop stays responsive to the request's deadline instead of
	// blocking on a slow or idle partition.
	fetchMaxWait = 500 * time.Millisecond

	// fetchMaxPartitionBytes caps how much a broker returns per partition in one
	// fetch. franz-go's default is 1 MiB, which is wildly oversized for how this
	// connector reads: a browse page divides its limit across every partition
	// (initialPartitionQuota in messages.go), so a 100-message page over a
	// 54-partition topic wants ~2 records per partition — tens of kilobytes — yet
	// the broker would happily ship a megabyte of each partition's tail that the
	// window filter then discards. Measured against a 54-partition topic with
	// ~10 KB records that meant ~100 MB pulled to display 48 rows, and the read
	// budget expired with less than half the partitions finished.
	//
	// The value is not simply "the window in bytes": franz-go buffers a run of
	// consecutive fetches before the reader's first PollFetches, so what actually
	// arrives is roughly this cap times that prefetch factor. Measured against a
	// local 54-partition topic of ~10 KB records, reading one 100-message page,
	// total records pulled scale linearly with the cap:
	//
	//	1 MiB (default)  21708 records / 212 MB
	//	128 KiB          14144 records / 138 MB   (1.5x)
	//	 64 KiB           5940 records /  58 MB   (3.7x)
	//	 32 KiB           2970 records /  29 MB   (7.3x)
	//	 16 KiB           1458 records /  14 MB   (14.9x)
	//
	// 32 KiB is the knee: still ~3 records per fetch at that record size against
	// the ~2 a page needs, with a 7x cut in bytes moved. Large messages are not
	// starved — since KIP-74 a broker always returns at least one complete record
	// batch even when it exceeds the requested maximum.
	//
	// The content-search path (maxScanMessages / dividedWindow) wants roughly an
	// order of magnitude more per partition and therefore trades one large fetch
	// for several smaller ones. That is a deliberate call: the round trips
	// pipeline per broker and scanTimeBudget is far more generous than the browse
	// budget, so a single shared client stays simpler than a second connection
	// pool to every broker.
	fetchMaxPartitionBytes = 32 << 10

	// fetchMaxBytes caps a whole fetch response from one broker. With the
	// per-partition cap above doing the real work this is only a backstop against
	// a broker that leads an unusually large share of a wide topic.
	fetchMaxBytes = 4 << 20
)

type kafkaSettings struct {
	brokers       []string
	saslMechanism string
	username      string
	password      string
	tlsEnabled    bool
	tlsCAPEM      string
}

type KafkaConnector struct {
	client *kgo.Client
	// consume is the fetch-loop seam used by consumeWindows. In production it is
	// the same *kgo.Client as client; tests inject a deterministic fake so
	// partial/timeout/cancellation reader behavior can be exercised without a
	// live broker. See partitionConsumer in messages.go.
	consume   partitionConsumer
	admin     *kadm.Client
	config    config.ConnectionConfig
	settings  kafkaSettings
	consumeMu sync.Mutex
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
	// FetchMaxWait keeps the message reader's poll loop responsive to its overall
	// read budget. Appended here rather than inside buildClientOpts so the auth/
	// TLS opt-count contract exercised by TestBuildClientOptsCoversAuthModes is
	// unaffected.
	opts = append(opts, kgo.FetchMaxWait(fetchMaxWait))
	// Sized to what the reader's partition windows actually consume rather than
	// franz-go's defaults; see the constants for the measurements behind them.
	opts = append(opts, kgo.FetchMaxPartitionBytes(fetchMaxPartitionBytes))
	opts = append(opts, kgo.FetchMaxBytes(fetchMaxBytes))
	// Without this the client strips retryable fetch errors, including the
	// UnknownTopicID that a delete/recreate of the same topic name produces — it
	// only surfaces after 6 occurrences, which the 3s read budget never reaches, so
	// the recreated topic looked like a plain timeout. franz-go's own docs point at
	// this flag for reacting to topic deletion; consumeWindows ignores every other
	// retryable error so the reader's behavior is otherwise unchanged.
	opts = append(opts, kgo.KeepRetryableFetchErrors())

	client, err := kgo.NewClient(opts...)
	if err != nil {
		return nil, fmt.Errorf("failed to create kafka client: %w", err)
	}

	conn := &KafkaConnector{
		client:   client,
		consume:  client,
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
		tlsCAPEM:      kafkaCfg.TLSCAPEM,
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
		tlsConfig, err := buildTLSConfig(settings.tlsCAPEM)
		if err != nil {
			return nil, fmt.Errorf("%w: invalid kafka TLS CA certificate: %v", connector.ErrBadRequest, err)
		}
		opts = append(opts, kgo.DialTLSConfig(tlsConfig))
	}

	return opts, nil
}

func buildTLSConfig(caPEM string) (*tls.Config, error) {
	tlsConfig := &tls.Config{MinVersion: tls.VersionTLS12}
	if strings.TrimSpace(caPEM) == "" {
		return tlsConfig, nil
	}

	rootCAs, err := x509.SystemCertPool()
	if err != nil {
		rootCAs = x509.NewCertPool()
	}
	if ok := rootCAs.AppendCertsFromPEM([]byte(caPEM)); !ok {
		return nil, errors.New("PEM data does not contain a valid certificate")
	}

	tlsConfig.RootCAs = rootCAs
	return tlsConfig, nil
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

	// kadm.BrokerMetadata is served from the client's in-memory cache and
	// never touches the network, so it cannot detect an unreachable cluster.
	// kgo's Ping issues a real broker-only Metadata request over the wire.
	return normalizeKafkaError(c.client.Ping(ctx))
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

// GetSchema describes a topic: its partition count plus its broker-reported
// configuration. Kafka has no columns, so Columns stays empty and everything
// lands in Meta.
func (c *KafkaConnector) GetSchema(ctx context.Context, object string) (*connector.Schema, error) {
	return c.topicSchema(ctx, object)
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
