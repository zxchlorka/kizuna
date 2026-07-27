package kafka

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/pem"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/twmb/franz-go/pkg/kadm"
	"github.com/twmb/franz-go/pkg/kgo"
	"github.com/zxchlorka/kizuna/internal/config"
	"github.com/zxchlorka/kizuna/internal/connector"
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
				Username: "app",
				KafkaConfig: &config.KafkaConfig{
					Brokers:       []string{"b:9092"},
					SASLMechanism: "scram-sha-256",
					TLSEnabled:    true,
					TLSCAPEM:      "  test-ca  ",
				},
			},
			want: kafkaSettings{
				brokers:       []string{"b:9092"},
				saslMechanism: config.KafkaSASLScramSHA256,
				username:      "app",
				tlsEnabled:    true,
				tlsCAPEM:      "test-ca",
			},
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
			if got.tlsEnabled != tc.want.tlsEnabled {
				t.Fatalf("unexpected tls enabled: got %t want %t", got.tlsEnabled, tc.want.tlsEnabled)
			}
			if got.tlsCAPEM != tc.want.tlsCAPEM {
				t.Fatalf("unexpected TLS CA PEM: got %q want %q", got.tlsCAPEM, tc.want.tlsCAPEM)
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

func TestBuildTLSConfig(t *testing.T) {
	t.Parallel()

	t.Run("system trust store", func(t *testing.T) {
		t.Parallel()

		got, err := buildTLSConfig("")
		if err != nil {
			t.Fatalf("build TLS config: %v", err)
		}
		if got.MinVersion != tls.VersionTLS12 {
			t.Fatalf("unexpected minimum TLS version: %d", got.MinVersion)
		}
		if got.RootCAs != nil {
			t.Fatalf("expected nil RootCAs to use the system trust store")
		}
	})

	t.Run("custom CA is trusted", func(t *testing.T) {
		t.Parallel()

		server := httptest.NewTLSServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
		defer server.Close()

		certificate := server.Certificate()
		caPEM := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: certificate.Raw})
		got, err := buildTLSConfig(string(caPEM))
		if err != nil {
			t.Fatalf("build TLS config: %v", err)
		}
		if got.RootCAs == nil {
			t.Fatal("expected custom root CA pool")
		}
		if got.InsecureSkipVerify {
			t.Fatal("hostname verification must remain enabled")
		}
		if _, err := certificate.Verify(x509.VerifyOptions{Roots: got.RootCAs}); err != nil {
			t.Fatalf("custom CA certificate is not trusted: %v", err)
		}
	})

	t.Run("invalid PEM", func(t *testing.T) {
		t.Parallel()

		_, err := buildClientOpts(kafkaSettings{
			brokers:    []string{"b:9092"},
			tlsEnabled: true,
			tlsCAPEM:   "not a certificate",
		})
		if !errors.Is(err, connector.ErrBadRequest) {
			t.Fatalf("expected bad request, got %v", err)
		}
	})
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

func TestParseSeek(t *testing.T) {
	t.Parallel()

	seekFilter := func(column, value string) []connector.FilterExpr {
		return []connector.FilterExpr{{Column: column, Op: "eq", Value: value}}
	}

	tests := []struct {
		name          string
		filters       []connector.FilterExpr
		wantEmpty     bool
		wantOffset    int64
		wantHasOffset bool
		wantMillis    int64
		wantHasTime   bool
		wantErr       bool
	}{
		{name: "no seek", wantEmpty: true},
		{
			name:          "offset",
			filters:       seekFilter("from_offset", "137820399911"),
			wantOffset:    137820399911,
			wantHasOffset: true,
		},
		{
			// Offsets are per partition, so one number means a different position
			// in each — but that is a question about the RESULT, not a malformed
			// request. It is accepted and GetData reports how many partitions the
			// number actually landed inside.
			name:          "offset across all partitions is accepted",
			filters:       seekFilter("from_offset", "100"),
			wantOffset:    100,
			wantHasOffset: true,
		},
		{
			name:    "negative offset",
			filters: seekFilter("from_offset", "-1"),
			wantErr: true,
		},
		{
			// A timestamp resolves independently inside each partition, so it needs
			// no partition scope.
			name:        "rfc3339 timestamp",
			filters:     seekFilter("from_timestamp", "2026-07-27T08:41:45Z"),
			wantMillis:  time.Date(2026, 7, 27, 8, 41, 45, 0, time.UTC).UnixMilli(),
			wantHasTime: true,
		},
		{
			name:        "epoch millis timestamp",
			filters:     seekFilter("from_timestamp", "1784889705000"),
			wantMillis:  1784889705000,
			wantHasTime: true,
		},
		{
			name:    "garbage timestamp",
			filters: seekFilter("from_timestamp", "yesterday"),
			wantErr: true,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			got, err := parseSeek(tc.filters)
			if tc.wantErr {
				if !errors.Is(err, connector.ErrBadRequest) {
					t.Fatalf("expected bad request, got %v", err)
				}
				return
			}
			if err != nil {
				t.Fatalf("parseSeek: %v", err)
			}
			if got.empty() != tc.wantEmpty {
				t.Errorf("empty() = %v, want %v", got.empty(), tc.wantEmpty)
			}
			if got.hasOffset != tc.wantHasOffset {
				t.Errorf("hasOffset = %v, want %v", got.hasOffset, tc.wantHasOffset)
			}
			if got.hasOffset && got.offset != tc.wantOffset {
				t.Errorf("offset = %d, want %d", got.offset, tc.wantOffset)
			}
			if got.hasTime != tc.wantHasTime {
				t.Errorf("hasTime = %v, want %v", got.hasTime, tc.wantHasTime)
			}
			if got.hasTime && got.at.UnixMilli() != tc.wantMillis {
				t.Errorf("at = %d ms, want %d ms", got.at.UnixMilli(), tc.wantMillis)
			}
		})
	}
}

// An offset seek names the newest message a page may show, so the exclusive
// window bound sits one past it. Off by one here would silently hide the very
// message the user seeked to.
func TestResolveSeekCeilingsOffsetIsInclusive(t *testing.T) {
	t.Parallel()

	conn := &KafkaConnector{}
	ceilings, err := conn.resolveSeekBounds(
		context.Background(),
		"orders",
		seekRequest{offset: 500, hasOffset: true},
		directionNewest,
		[]int32{3},
	)
	if err != nil {
		t.Fatalf("resolveSeekBounds: %v", err)
	}
	if got := ceilings[3]; got != 501 {
		t.Fatalf("ceiling for partition 3 = %d, want 501 (exclusive bound one past the seeked offset)", got)
	}
	if len(ceilings) != 1 {
		t.Fatalf("an offset seek must only bound its own partition, got %d entries", len(ceilings))
	}
}

func TestParseBeforeOffsets(t *testing.T) {
	t.Parallel()

	offsets, err := parseCursorOffsets([]connector.FilterExpr{{Column: "before_offsets", Op: "eq", Value: `{"0":120,"2":48}`}}, directionNewest)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if offsets[0] != 120 || offsets[2] != 48 {
		t.Fatalf("unexpected offsets: %#v", offsets)
	}

	if _, err := parseCursorOffsets([]connector.FilterExpr{{Column: "before_offsets", Op: "eq", Value: `{"x":1}`}}, directionNewest); !errors.Is(err, connector.ErrBadRequest) {
		t.Fatalf("expected bad request for non-numeric partition, got %v", err)
	}
	if _, err := parseCursorOffsets([]connector.FilterExpr{{Column: "before_offsets", Op: "eq", Value: `not-json`}}, directionNewest); !errors.Is(err, connector.ErrBadRequest) {
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
		{name: "nested array full path", row: jsonRow(`{"src":{"event_data":{"events":[{"name":"View"},{"name":"Auth"}]}}}`), field: "src.event_data.events[].name", want: "Auth", match: true},
		{name: "nested array implicit wildcard", row: jsonRow(`{"src":{"event_data":{"events":[{"name":"Auth"}]}}}`), field: "src.event_data.events.name", want: "Auth", match: true},
		{name: "suffix path below root", row: jsonRow(`{"src":{"event_data":{"events":[{"name":"Auth"}]}}}`), field: "events[].name", want: "Auth", match: true},
		{name: "suffix scalar below root", row: jsonRow(`{"src":{"event_data":{"events":[{"name":"Auth"}]}}}`), field: "name", want: "Auth", match: true},
		{name: "array value mismatch", row: jsonRow(`{"events":[{"name":"View"}]}`), field: "events[].name", want: "Auth", match: false},
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

func TestNormalPartitionWindow(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name  string
		limit int
		want  int64
	}{
		{name: "default page", limit: 50, want: 50},
		{name: "large page", limit: 500, want: 500},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			if got := normalPartitionWindow(tc.limit); got != tc.want {
				t.Fatalf("normalPartitionWindow = %d, want %d", got, tc.want)
			}
		})
	}
}

func TestSelectNewestPrefixesKeepsLosslessPartitionCursors(t *testing.T) {
	t.Parallel()

	row := func(partition int32, offset int64, timestamp string) map[string]any {
		return map[string]any{"partition": partition, "offset": offset, "timestamp": timestamp}
	}
	rows := []map[string]any{
		row(0, 98, "2026-01-01T00:00:01Z"),
		row(0, 100, "2026-01-01T00:00:05Z"),
		row(0, 99, "2026-01-01T00:00:03Z"),
		row(1, 199, "2026-01-01T00:00:02Z"),
		row(1, 200, "2026-01-01T00:00:04Z"),
	}

	selected := selectDirectionalPrefixes(rows, 3, directionNewest)
	if len(selected) != 3 {
		t.Fatalf("selected %d rows, want 3", len(selected))
	}
	want := [][2]int64{{0, 100}, {1, 200}, {0, 99}}
	for i, pair := range want {
		partition, _ := selected[i]["partition"].(int32)
		offset, _ := selected[i]["offset"].(int64)
		if int64(partition) != pair[0] || offset != pair[1] {
			t.Fatalf("selected[%d] = (%d,%d), want (%d,%d)", i, partition, offset, pair[0], pair[1])
		}
	}

	frontier := lowestConsumedOffsets(selected)
	if frontier[0] != 99 || frontier[1] != 200 {
		t.Fatalf("unexpected lossless frontier: %#v", frontier)
	}
}

func TestSortRowsNewestUsesTimestampChronology(t *testing.T) {
	t.Parallel()

	rows := []map[string]any{
		{"partition": int32(0), "offset": int64(10), "timestamp": "2026-07-20T13:59:17.81Z"},
		{"partition": int32(0), "offset": int64(11), "timestamp": "2026-07-20T13:59:17.811Z"},
	}
	sortRowsDirectional(rows, directionNewest)
	if got := rows[0]["offset"]; got != int64(11) {
		t.Fatalf("newest offset = %v, want 11", got)
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

// Ping must perform real network I/O: kadm.BrokerMetadata is answered from the
// client's in-memory cache and reported healthy clusters that were unreachable.
func TestPingFailsWhenBrokersUnreachable(t *testing.T) {
	t.Parallel()

	client, err := kgo.NewClient(kgo.SeedBrokers("127.0.0.1:1"))
	if err != nil {
		t.Fatalf("failed to create kafka client: %v", err)
	}
	defer client.Close()

	conn := &KafkaConnector{client: client, admin: kadm.NewClient(client)}

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()

	if err := conn.Ping(ctx); err == nil {
		t.Fatal("expected ping to fail for an unreachable broker")
	}
}

func TestParseJSONPath(t *testing.T) {
	t.Parallel()

	key := func(k string) jsonPathSegment { return jsonPathSegment{kind: jsonPathKey, key: k} }
	idx := jsonPathSegment{kind: jsonPathIndex}

	tests := []struct {
		name string
		in   string
		want []jsonPathSegment
	}{
		{name: "plain scalar", in: "event_type", want: []jsonPathSegment{key("event_type")}},
		{name: "dot path", in: "user.id", want: []jsonPathSegment{key("user"), key("id")}},
		{
			name: "nested object array object scalar",
			in:   "src.event_data.events[].name",
			want: []jsonPathSegment{key("src"), key("event_data"), key("events"), idx, key("name")},
		},
		{
			name: "two array levels",
			in:   "items[].attributes[].value",
			want: []jsonPathSegment{key("items"), idx, key("attributes"), idx, key("value")},
		},
		{
			name: "bracket key with dot",
			in:   `["key.with.dot"].name`,
			want: []jsonPathSegment{key("key.with.dot"), key("name")},
		},
		{name: "legacy wildcard alias", in: "events[*].name", want: []jsonPathSegment{key("events"), idx, key("name")}},
		{name: "leading dollar and dot", in: "$.user.id", want: []jsonPathSegment{key("user"), key("id")}},
		{name: "single quoted bracket key", in: `['a.b'].c`, want: []jsonPathSegment{key("a.b"), key("c")}},
	}

	for _, tc := range tests {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			got := parseJSONPath(tc.in)
			if len(got) != len(tc.want) {
				t.Fatalf("parseJSONPath(%q) = %+v, want %+v", tc.in, got, tc.want)
			}
			for i := range got {
				if got[i] != tc.want[i] {
					t.Fatalf("parseJSONPath(%q)[%d] = %+v, want %+v", tc.in, i, got[i], tc.want[i])
				}
			}
		})
	}
}

// jsonPathSharedFixtures is the cross-language grammar test matrix. The exact
// same documents/paths/wants/expectations are asserted in TypeScript by
// frontend/src/lib/jsonPaths.test.ts, so the Go matcher and the TS traversal
// provably agree on the canonical grammar. Only full paths from the root are
// used here (no legacy suffix paths), which is where the strict TS traversal and
// the lenient Go matcher must produce identical results.
var jsonPathSharedFixtures = []struct {
	name  string
	doc   string
	path  string
	want  string
	match bool
}{
	{name: "top-level string", doc: `{"event_type":"batch","count":3,"ok":true}`, path: "event_type", want: "batch", match: true},
	{name: "top-level number", doc: `{"event_type":"batch","count":3,"ok":true}`, path: "count", want: "3", match: true},
	{name: "top-level bool", doc: `{"event_type":"batch","count":3,"ok":true}`, path: "ok", want: "true", match: true},
	{name: "top-level number mismatch", doc: `{"event_type":"batch","count":3,"ok":true}`, path: "count", want: "4", match: false},
	{name: "nested obj array obj scalar (Auth)", doc: `{"src":{"event_data":{"events":[{"name":"View"},{"name":"Auth"}]}}}`, path: "src.event_data.events[].name", want: "Auth", match: true},
	{name: "nested array first element", doc: `{"src":{"event_data":{"events":[{"name":"View"},{"name":"Auth"}]}}}`, path: "src.event_data.events[].name", want: "View", match: true},
	{name: "nested array no such value", doc: `{"src":{"event_data":{"events":[{"name":"View"},{"name":"Auth"}]}}}`, path: "src.event_data.events[].name", want: "Nope", match: false},
	{name: "nested arrays two levels", doc: `{"src":{"event_data":{"events":[{"data":{"items":[{"category":["regular","6208"]}]}},{"data":{"items":[{"category":["spool"]}]}}]}}}`, path: "src.event_data.events[].data.items[].category[]", want: "6208", match: true},
	{name: "nested arrays other branch", doc: `{"src":{"event_data":{"events":[{"data":{"items":[{"category":["regular","6208"]}]}},{"data":{"items":[{"category":["spool"]}]}}]}}}`, path: "src.event_data.events[].data.items[].category[]", want: "spool", match: true},
	{name: "nested arrays miss", doc: `{"src":{"event_data":{"events":[{"data":{"items":[{"category":["regular","6208"]}]}},{"data":{"items":[{"category":["spool"]}]}}]}}}`, path: "src.event_data.events[].data.items[].category[]", want: "nope", match: false},
	{name: "missing field", doc: `{"src":{"event_data":{"events":[{"name":"Auth"}]}}}`, path: "src.event_data.missing", want: "x", match: false},
	{name: "null matches null literal", doc: `{"src":{"timezone_offset":null}}`, path: "src.timezone_offset", want: "null", match: true},
	{name: "null does not match zero", doc: `{"src":{"timezone_offset":null}}`, path: "src.timezone_offset", want: "0", match: false},
	{name: "mixed types scalar branch", doc: `{"a":{"b":"X"}}`, path: "a.b", want: "X", match: true},
	{name: "mixed types object branch no match", doc: `{"a":{"b":{"nested":1}}}`, path: "a.b", want: "X", match: false},
	{name: "mixed types descend past scalar", doc: `{"a":{"b":"X"}}`, path: "a.b.c", want: "X", match: false},
	{name: "invalid json", doc: `{not json`, path: "a", want: "anything", match: false},
	{name: "key with dot bracket notation", doc: `{"key.with.dot":{"name":"Zulu"}}`, path: `["key.with.dot"].name`, want: "Zulu", match: true},
	{name: "key with dot plain path does not match", doc: `{"key.with.dot":{"name":"Zulu"}}`, path: "key.with.dot.name", want: "Zulu", match: false},
}

func TestJSONPathSharedFixtures(t *testing.T) {
	t.Parallel()

	for _, tc := range jsonPathSharedFixtures {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			row := map[string]any{"format": "json", "value": tc.doc}
			if got := messageMatchesField(row, tc.path, tc.want); got != tc.match {
				t.Fatalf("messageMatchesField(%q, %q, %q) = %v, want %v", tc.doc, tc.path, tc.want, got, tc.match)
			}
		})
	}
}
