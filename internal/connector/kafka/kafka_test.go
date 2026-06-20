package kafka

import (
	"context"
	"errors"
	"testing"

	"github.com/qsnake66/infraview/internal/config"
	"github.com/qsnake66/infraview/internal/connector"
	"github.com/twmb/franz-go/pkg/kadm"
)

func TestResolveKafkaSettings(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name    string
		cfg     config.ConnectionConfig
		want    kafkaSettings
		wantErr bool
	}{
		{
			name: "brokers from kafka config",
			cfg: config.ConnectionConfig{
				KafkaConfig: &config.KafkaConfig{Brokers: []string{" broker-1:9092 ", "broker-2:9092", "broker-1:9092"}},
			},
			want: kafkaSettings{brokers: []string{"broker-1:9092", "broker-2:9092"}},
		},
		{
			name: "falls back to host and port",
			cfg:  config.ConnectionConfig{Host: "kafka.example", Port: 9095},
			want: kafkaSettings{brokers: []string{"kafka.example:9095"}},
		},
		{
			name: "host without port uses 9092",
			cfg:  config.ConnectionConfig{Host: "kafka.example"},
			want: kafkaSettings{brokers: []string{"kafka.example:9092"}},
		},
		{
			name:    "no brokers fails",
			cfg:     config.ConnectionConfig{KafkaConfig: &config.KafkaConfig{}},
			wantErr: true,
		},
		{
			name: "sasl with username",
			cfg: config.ConnectionConfig{
				Username:    "app",
				KafkaConfig: &config.KafkaConfig{Brokers: []string{"b:9092"}, SASLMechanism: "scram-sha-256"},
			},
			want: kafkaSettings{brokers: []string{"b:9092"}, saslMechanism: config.KafkaSASLScramSHA256, username: "app"},
		},
		{
			name: "sasl without username fails",
			cfg: config.ConnectionConfig{
				KafkaConfig: &config.KafkaConfig{Brokers: []string{"b:9092"}, SASLMechanism: "PLAIN"},
			},
			wantErr: true,
		},
		{
			name: "unknown mechanism fails",
			cfg: config.ConnectionConfig{
				Username:    "app",
				KafkaConfig: &config.KafkaConfig{Brokers: []string{"b:9092"}, SASLMechanism: "GSSAPI"},
			},
			wantErr: true,
		},
	}

	for _, tc := range tests {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			got, err := resolveKafkaSettings(tc.cfg, "")
			if tc.wantErr {
				if !errors.Is(err, connector.ErrBadRequest) {
					t.Fatalf("expected bad request error, got %v", err)
				}
				return
			}
			if err != nil {
				t.Fatalf("resolve settings: %v", err)
			}
			if len(got.brokers) != len(tc.want.brokers) {
				t.Fatalf("unexpected brokers: got %v want %v", got.brokers, tc.want.brokers)
			}
			for i := range tc.want.brokers {
				if got.brokers[i] != tc.want.brokers[i] {
					t.Fatalf("unexpected brokers: got %v want %v", got.brokers, tc.want.brokers)
				}
			}
			if got.saslMechanism != tc.want.saslMechanism {
				t.Fatalf("unexpected mechanism: got %q want %q", got.saslMechanism, tc.want.saslMechanism)
			}
			if got.username != tc.want.username {
				t.Fatalf("unexpected username: got %q want %q", got.username, tc.want.username)
			}
		})
	}
}

func TestBuildClientOptsCoversAuthModes(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name     string
		settings kafkaSettings
		wantOpts int
	}{
		{name: "plaintext", settings: kafkaSettings{brokers: []string{"b:9092"}}, wantOpts: 1},
		{name: "tls", settings: kafkaSettings{brokers: []string{"b:9092"}, tlsEnabled: true}, wantOpts: 2},
		{name: "sasl plain", settings: kafkaSettings{brokers: []string{"b:9092"}, saslMechanism: config.KafkaSASLPlain, username: "u", password: "p"}, wantOpts: 2},
		{name: "scram 256 with tls", settings: kafkaSettings{brokers: []string{"b:9092"}, saslMechanism: config.KafkaSASLScramSHA256, username: "u", password: "p", tlsEnabled: true}, wantOpts: 3},
		{name: "scram 512", settings: kafkaSettings{brokers: []string{"b:9092"}, saslMechanism: config.KafkaSASLScramSHA512, username: "u", password: "p"}, wantOpts: 2},
	}

	for _, tc := range tests {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			opts, err := buildClientOpts(tc.settings)
			if err != nil {
				t.Fatalf("build opts: %v", err)
			}
			if len(opts) != tc.wantOpts {
				t.Fatalf("unexpected opt count: got %d want %d", len(opts), tc.wantOpts)
			}
		})
	}
}

func TestParsePartitionFilter(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name    string
		filters []connector.FilterExpr
		want    int32
		wantErr bool
	}{
		{name: "no filter", want: -1},
		{name: "valid", filters: []connector.FilterExpr{{Column: "partition", Op: "eq", Value: "2"}}, want: 2},
		{name: "negative", filters: []connector.FilterExpr{{Column: "partition", Op: "eq", Value: "-3"}}, wantErr: true},
		{name: "garbage", filters: []connector.FilterExpr{{Column: "partition", Op: "eq", Value: "abc"}}, wantErr: true},
	}

	for _, tc := range tests {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			got, err := parsePartitionFilter(tc.filters)
			if tc.wantErr {
				if !errors.Is(err, connector.ErrBadRequest) {
					t.Fatalf("expected bad request, got %v", err)
				}
				return
			}
			if err != nil {
				t.Fatalf("parse: %v", err)
			}
			if got != tc.want {
				t.Fatalf("unexpected partition: got %d want %d", got, tc.want)
			}
		})
	}
}

func TestParseBeforeOffsets(t *testing.T) {
	t.Parallel()

	offsets, err := parseBeforeOffsets([]connector.FilterExpr{{Column: "before_offsets", Op: "eq", Value: `{"0":120,"2":48}`}})
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if offsets[0] != 120 || offsets[2] != 48 {
		t.Fatalf("unexpected offsets: %#v", offsets)
	}

	if _, err := parseBeforeOffsets([]connector.FilterExpr{{Column: "before_offsets", Op: "eq", Value: `{"x":1}`}}); !errors.Is(err, connector.ErrBadRequest) {
		t.Fatalf("expected bad request for non-numeric partition, got %v", err)
	}
	if _, err := parseBeforeOffsets([]connector.FilterExpr{{Column: "before_offsets", Op: "eq", Value: `not-json`}}); !errors.Is(err, connector.ErrBadRequest) {
		t.Fatalf("expected bad request for invalid json, got %v", err)
	}
}

func TestParseMatchFilter(t *testing.T) {
	t.Parallel()

	field, value := parseMatchFilter([]connector.FilterExpr{
		{Column: "match_field", Value: " user.id "},
		{Column: "match_value", Value: "42"},
	})
	if field != "user.id" || value != "42" {
		t.Fatalf("unexpected match filter: field=%q value=%q", field, value)
	}

	if field, _ := parseMatchFilter(nil); field != "" {
		t.Fatalf("expected empty field for no filter, got %q", field)
	}
}

func TestMessageMatchesField(t *testing.T) {
	t.Parallel()

	jsonRow := func(value string) map[string]any {
		return map[string]any{"format": "json", "value": value}
	}

	tests := []struct {
		name  string
		row   map[string]any
		field string
		want  string
		match bool
	}{
		{name: "top-level number", row: jsonRow(`{"product_id":123,"k":1}`), field: "product_id", want: "123", match: true},
		{name: "number mismatch", row: jsonRow(`{"product_id":123}`), field: "product_id", want: "124", match: false},
		{name: "dot path", row: jsonRow(`{"user":{"id":"u-7"}}`), field: "user.id", want: "u-7", match: true},
		{name: "missing path", row: jsonRow(`{"user":{"id":"u-7"}}`), field: "user.name", want: "x", match: false},
		{name: "string value", row: jsonRow(`{"status":"paid"}`), field: "status", want: "paid", match: true},
		{name: "bool value", row: jsonRow(`{"ok":true}`), field: "ok", want: "true", match: true},
		{name: "nested object never matches", row: jsonRow(`{"user":{"id":1}}`), field: "user", want: "anything", match: false},
		{name: "non-json never matches", row: map[string]any{"format": "text", "value": "product_id=123"}, field: "product_id", want: "123", match: false},
		{name: "empty field matches all", row: jsonRow(`{"a":1}`), field: "", want: "", match: true},
	}

	for _, tc := range tests {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			if got := messageMatchesField(tc.row, tc.field, tc.want); got != tc.match {
				t.Fatalf("messageMatchesField = %v, want %v", got, tc.match)
			}
		})
	}
}

func TestLowestConsumedOffsets(t *testing.T) {
	t.Parallel()

	rows := []map[string]any{
		{"partition": int32(0), "offset": int64(50)},
		{"partition": int32(0), "offset": int64(20)},
		{"partition": int32(1), "offset": int64(99)},
	}
	reached := lowestConsumedOffsets(rows)
	if reached[0] != 20 || reached[1] != 99 {
		t.Fatalf("unexpected reached offsets: %#v", reached)
	}
}

func TestDeserializePayload(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name       string
		data       []byte
		wantFormat string
		wantValue  string
	}{
		{name: "empty", data: nil, wantFormat: "empty", wantValue: ""},
		{name: "json object", data: []byte(`{"id":1}`), wantFormat: "json", wantValue: `{"id":1}`},
		{name: "json array", data: []byte(`[1,2]`), wantFormat: "json", wantValue: `[1,2]`},
		{name: "scalar stays text", data: []byte(`12345`), wantFormat: "text", wantValue: "12345"},
		{name: "broken json is text", data: []byte(`{"id":`), wantFormat: "text", wantValue: `{"id":`},
		{name: "binary", data: []byte{0xff, 0xfe, 0x00, 0x01}, wantFormat: "binary", wantValue: "//4AAQ=="},
	}

	for _, tc := range tests {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			value, format := deserializePayload(tc.data)
			if format != tc.wantFormat {
				t.Fatalf("unexpected format: got %q want %q", format, tc.wantFormat)
			}
			if value != tc.wantValue {
				t.Fatalf("unexpected value: got %q want %q", value, tc.wantValue)
			}
		})
	}
}

func TestPartitionsAllErrored(t *testing.T) {
	t.Parallel()

	unknown := errors.New("UNKNOWN_TOPIC_OR_PARTITION")

	allErrored := map[int32]kadm.ListedOffset{
		0: {Topic: "ghost", Partition: 0, Err: unknown},
	}
	if !partitionsAllErrored(allErrored) {
		t.Fatalf("expected all-errored partitions to report true")
	}

	healthy := map[int32]kadm.ListedOffset{
		0: {Topic: "orders", Partition: 0, Offset: 10},
		1: {Topic: "orders", Partition: 1, Err: unknown},
	}
	if partitionsAllErrored(healthy) {
		t.Fatalf("expected partially healthy partitions to report false")
	}
}

func TestBuildProduceRecords(t *testing.T) {
	t.Parallel()

	partition := int32(2)
	req := connector.KafkaProduceRequest{
		Topic:     "orders",
		Partition: &partition,
		Messages: []connector.KafkaProduceMessage{
			{Key: "k1", Value: `{"a":1}`, Headers: map[string]string{"source": "qa"}},
			{Value: `{"b":2}`},
		},
	}

	records := buildProduceRecords(req)
	if len(records) != 2 {
		t.Fatalf("expected 2 records, got %d", len(records))
	}

	first := records[0]
	if first.Topic != "orders" || string(first.Key) != "k1" || string(first.Value) != `{"a":1}` {
		t.Fatalf("unexpected first record: %+v", first)
	}
	if first.Partition != 2 {
		t.Fatalf("expected pinned partition 2, got %d", first.Partition)
	}
	if len(first.Headers) != 1 || first.Headers[0].Key != "source" || string(first.Headers[0].Value) != "qa" {
		t.Fatalf("unexpected headers: %+v", first.Headers)
	}

	second := records[1]
	if second.Key != nil {
		t.Fatalf("expected nil key for keyless message, got %q", second.Key)
	}
}

func TestBuildProduceRecordsAutoPartition(t *testing.T) {
	t.Parallel()

	records := buildProduceRecords(connector.KafkaProduceRequest{
		Topic:    "orders",
		Messages: []connector.KafkaProduceMessage{{Value: `{"a":1}`}},
	})
	if records[0].Partition != 0 {
		t.Fatalf("auto-partition records should leave Partition at zero value, got %d", records[0].Partition)
	}
}

func TestProduceValidation(t *testing.T) {
	t.Parallel()

	conn := &KafkaConnector{settings: kafkaSettings{brokers: []string{"b:9092"}}}

	tests := []struct {
		name string
		req  connector.KafkaProduceRequest
	}{
		{name: "empty topic", req: connector.KafkaProduceRequest{Messages: []connector.KafkaProduceMessage{{Value: "{}"}}}},
		{name: "no messages", req: connector.KafkaProduceRequest{Topic: "orders"}},
		{
			name: "too many messages",
			req: connector.KafkaProduceRequest{
				Topic:    "orders",
				Messages: make([]connector.KafkaProduceMessage, maxProduceMessages+1),
			},
		},
		{
			name: "negative partition",
			req: connector.KafkaProduceRequest{
				Topic:     "orders",
				Partition: ptrInt32(-1),
				Messages:  []connector.KafkaProduceMessage{{Value: "{}"}},
			},
		},
	}

	for _, tc := range tests {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			if _, err := conn.Produce(context.Background(), tc.req); !errors.Is(err, connector.ErrBadRequest) {
				t.Fatalf("expected bad request, got %v", err)
			}
		})
	}
}

func ptrInt32(v int32) *int32 { return &v }

func TestReadOnlyBlocksProduce(t *testing.T) {
	t.Parallel()

	conn := &KafkaConnector{
		config:   config.ConnectionConfig{ReadOnly: true},
		settings: kafkaSettings{brokers: []string{"b:9092"}},
	}
	_, err := conn.Produce(context.Background(), connector.KafkaProduceRequest{
		Topic:    "orders",
		Messages: []connector.KafkaProduceMessage{{Value: "{}"}},
	})
	if !errors.Is(err, connector.ErrReadOnly) {
		t.Fatalf("expected ErrReadOnly, got %v", err)
	}
}

func TestTopicMessageEstimate(t *testing.T) {
	t.Parallel()

	starts := kadm.ListedOffsets{
		"orders": {
			0: {Topic: "orders", Partition: 0, Offset: 10},
			1: {Topic: "orders", Partition: 1, Offset: 0},
		},
	}
	ends := kadm.ListedOffsets{
		"orders": {
			0: {Topic: "orders", Partition: 0, Offset: 110},
			1: {Topic: "orders", Partition: 1, Offset: 40},
		},
	}

	got := topicMessageEstimate("orders", []int32{0, 1}, starts, ends)
	if got != 140 {
		t.Fatalf("unexpected estimate: got %d want 140", got)
	}
}
