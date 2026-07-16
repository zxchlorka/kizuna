package connector

import "context"

// Connector is the core interface that all data source connectors implement.
type Connector interface {
	Ping(ctx context.Context) error
	GetInfo(ctx context.Context) (*ConnInfo, error)
	ListObjects(ctx context.Context, path string) ([]Object, error)
	GetObjectInfo(ctx context.Context, object string) (*ObjectInfo, error)
	GetSchema(ctx context.Context, object string) (*Schema, error)
	GetData(ctx context.Context, object string, opts DataOpts) (*DataResult, error)
	Execute(ctx context.Context, command string) (*ExecResult, error)
	ExecuteBatch(ctx context.Context, commands []string) ([]ExecResult, error)
	Explain(ctx context.Context, query string) (*ExplainResult, error)
	Analyze(ctx context.Context, query string) (*ExplainResult, error)
	Completions(ctx context.Context, req CompletionRequest) ([]CompletionItem, error)
	Mutate(ctx context.Context, op MutateOp) (*MutateResult, error)
	MutateBulk(ctx context.Context, op BulkMutateOp) (*BulkMutateResult, error)
	DDL(ctx context.Context, op DDLOp) error
	Close() error
}

type ConnInfo struct {
	Version  string         `json:"version"`
	Database string         `json:"database"`
	Host     string         `json:"host"`
	Port     string         `json:"port"`
	Extra    map[string]any `json:"extra,omitempty"`
}

type Object struct {
	Name       string         `json:"name"`
	Type       string         `json:"type"`
	Schema     string         `json:"schema"`
	RowCount   int64          `json:"row_count"`
	ParentName string         `json:"parent_name,omitempty"`
	Path       string         `json:"path,omitempty"`
	TTLSeconds *int64         `json:"ttl_seconds,omitempty"`
	Meta       map[string]any `json:"meta,omitempty"`
}

// ObjectPageOpts selects one page of an incremental object listing.
// Cursor is an opaque token from a previous page ("" = first page).
// Node optionally pins the listing to a single cluster node.
type ObjectPageOpts struct {
	Path   string
	Cursor string
	Node   string
}

type ObjectPage struct {
	Objects    []Object `json:"objects"`
	NextCursor string   `json:"next_cursor,omitempty"`
	Truncated  bool     `json:"truncated"`
}

// PagedObjectLister is an optional capability for connectors whose keyspace is
// too large to list in one shot (e.g. Redis). Connectors that implement it get
// cursor-based tree loading; others keep the plain ListObjects contract.
type PagedObjectLister interface {
	ListObjectsPage(ctx context.Context, opts ObjectPageOpts) (*ObjectPage, error)
}

// SQLCatalogColumn is one column of a table in the SQL catalog snapshot.
type SQLCatalogColumn struct {
	Name string `json:"name"`
	Type string `json:"type"`
}

// SQLCatalog is a schema → table → columns snapshot of a SQL database, used by
// editors for schema-aware autocomplete. Truncated is set when the database has
// more columns than the connector's cap and the snapshot is incomplete.
type SQLCatalog struct {
	Schemas       map[string]map[string][]SQLCatalogColumn `json:"schemas"`
	DefaultSchema string                                   `json:"default_schema,omitempty"`
	Truncated     bool                                     `json:"truncated,omitempty"`
}

// SQLCatalogProvider is an optional capability for connectors that can expose
// a full SQL schema catalog (currently Postgres only).
type SQLCatalogProvider interface {
	SQLCatalog(ctx context.Context) (*SQLCatalog, error)
}

// KafkaProduceMessage is one already-expanded message to publish. Loop/multi
// template expansion happens client-side; the backend just publishes the batch.
type KafkaProduceMessage struct {
	Key     string            `json:"key,omitempty"`
	Value   string            `json:"value"`
	Headers map[string]string `json:"headers,omitempty"`
}

// KafkaProduceRequest publishes a batch to one topic. Partition pins all
// messages to a single partition; nil uses the default key-hash partitioner.
type KafkaProduceRequest struct {
	Topic     string                `json:"topic"`
	Partition *int32                `json:"partition,omitempty"`
	Messages  []KafkaProduceMessage `json:"messages"`
}

type KafkaProduceResult struct {
	Produced   int            `json:"produced"`
	Failed     int            `json:"failed"`
	Errors     []string       `json:"errors,omitempty"`
	Partitions map[string]int `json:"partitions,omitempty"`
}

// KafkaProducer is an optional capability for connectors that can publish
// messages (Kafka). The API exposes it via POST /produce.
type KafkaProducer interface {
	Produce(ctx context.Context, req KafkaProduceRequest) (*KafkaProduceResult, error)
}

type ObjectInfo struct {
	Name       string   `json:"name"`
	Schema     string   `json:"schema"`
	ObjectType string   `json:"object_type"`
	OwnerTable string   `json:"owner_table,omitempty"`
	Columns    []string `json:"columns,omitempty"`
	Method     string   `json:"method,omitempty"`
	IsUnique   bool     `json:"is_unique"`
	Predicate  *string  `json:"predicate,omitempty"`
	Definition string   `json:"definition,omitempty"`
}

type Schema struct {
	ObjectType   string         `json:"object_type,omitempty"`
	Columns      []ColumnMeta   `json:"columns"`
	ReferencedBy []FKRef        `json:"referenced_by,omitempty"`
	Meta         map[string]any `json:"meta,omitempty"`
}

type FKRef struct {
	Table     string `json:"table"`
	Column    string `json:"column"`
	RefColumn string `json:"ref_column"`
}

type ColumnMeta struct {
	Name     string  `json:"name"`
	DataType string  `json:"data_type"`
	Nullable bool    `json:"nullable"`
	Default  *string `json:"default,omitempty"`
	IsPK     bool    `json:"is_pk"`
	IsFK     bool    `json:"is_fk"`
	FKTable  string  `json:"fk_table,omitempty"`
	FKColumn string  `json:"fk_column,omitempty"`
	Editable bool    `json:"editable,omitempty"`
}

type DataOpts struct {
	Offset   int          `json:"offset"`
	Limit    int          `json:"limit"`
	OrderBy  string       `json:"order_by"`
	OrderDir string       `json:"order_dir"`
	Filters  []FilterExpr `json:"filters"`
}

type FilterExpr struct {
	Column string `json:"column"`
	Op     string `json:"op"`
	Value  string `json:"value"`
}

type DataResult struct {
	Columns []ColumnMeta     `json:"columns"`
	Rows    []map[string]any `json:"rows"`
	Total   int64            `json:"total"`
	HasMore bool             `json:"has_more"`
	Meta    map[string]any   `json:"meta,omitempty"`
}

type MutateOp struct {
	Type   string         `json:"type"`
	Object string         `json:"object"`
	Schema string         `json:"schema"`
	Where  map[string]any `json:"where"`
	Data   map[string]any `json:"data"`
}

type DDLOp struct {
	Type   string         `json:"type"`
	Schema string         `json:"schema"`
	Object string         `json:"object"`
	Params map[string]any `json:"params"`
}

// ColumnSource is the origin table/column of a SQL result column, when it maps
// to a real table column (not an expression/aggregate).
type ColumnSource struct {
	Table  string `json:"table"` // schema.table
	Column string `json:"column"`
}

type ExecResult struct {
	Columns       []string        `json:"columns"`
	ColumnTypes   []string        `json:"column_types,omitempty"`
	Rows          [][]any         `json:"rows"`
	RowsAffected  int64           `json:"rows_affected"`
	Statement     string          `json:"statement,omitempty"`
	Error         string          `json:"error,omitempty"`
	DurationMs    int64           `json:"duration_ms"`
	RowsReturned  int             `json:"rows_returned"`
	RowReturning  bool            `json:"row_returning,omitempty"` // statement produced a result set (even with zero columns/rows)
	Truncated     bool            `json:"truncated,omitempty"`
	AppliedLimit  int             `json:"applied_limit,omitempty"`
	ColumnSources []*ColumnSource `json:"column_sources,omitempty"` // aligned to Columns; nil for expressions
	Skipped       bool            `json:"skipped,omitempty"`
}

type MutateResult struct {
	RowsAffected int64 `json:"rows_affected"`
	Row          []any `json:"row,omitempty"`
}

type BulkMutateOp struct {
	Schema     string     `json:"schema"`
	Object     string     `json:"object"`
	Operations []MutateOp `json:"operations"`
	Pattern    string     `json:"pattern,omitempty"`
	Preview    bool       `json:"preview,omitempty"`
	Execute    bool       `json:"execute,omitempty"`
	ConfirmAll bool       `json:"confirm_all,omitempty"`
	BatchSize  int        `json:"batch_size,omitempty"`
}

type BulkMutateResult struct {
	Applied      int    `json:"applied"`
	RowsAffected int64  `json:"rows_affected"`
	Message      string `json:"message"`
}

type ExplainNode struct {
	NodeType         string        `json:"node_type"`
	RelationName     string        `json:"relation_name,omitempty"`
	Alias            string        `json:"alias,omitempty"`
	StartupCost      float64       `json:"startup_cost"`
	TotalCost        float64       `json:"total_cost"`
	PlanRows         int64         `json:"plan_rows"`
	ActualRows       float64       `json:"actual_rows"`
	ActualTimeMs     float64       `json:"actual_time_ms"`
	SharedHitBlocks  int64         `json:"shared_hit_blocks"`
	SharedReadBlocks int64         `json:"shared_read_blocks"`
	IsBottleneck     bool          `json:"is_bottleneck,omitempty"`
	Children         []ExplainNode `json:"children,omitempty"`
}

type ExplainResult struct {
	Plan       ExplainNode `json:"plan"`
	DurationMs int64       `json:"duration_ms"`
	Mode       string      `json:"mode"`
}

type CompletionRequest struct {
	Prefix  string `json:"prefix"`
	Context string `json:"context"`
	Table   string `json:"table,omitempty"`
}

type CompletionItem struct {
	Label  string `json:"label"`
	Type   string `json:"type"`
	Detail string `json:"detail,omitempty"`
}

type HistoryEntry struct {
	ID           string `json:"id"`
	Command      string `json:"command"`
	DurationMs   int64  `json:"duration_ms"`
	RowsReturned int    `json:"rows_returned"`
	RowsAffected int64  `json:"rows_affected"`
	Error        string `json:"error,omitempty"`
	ExecutedAt   string `json:"executed_at"`
}
