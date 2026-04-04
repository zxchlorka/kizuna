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
	Name       string `json:"name"`
	Type       string `json:"type"`
	Schema     string `json:"schema"`
	RowCount   int64  `json:"row_count"`
	ParentName string `json:"parent_name,omitempty"`
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
	Columns []ColumnMeta `json:"columns"`
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

type ExecResult struct {
	Columns      []string `json:"columns"`
	Rows         [][]any  `json:"rows"`
	RowsAffected int64    `json:"rows_affected"`
}

type MutateResult struct {
	RowsAffected int64 `json:"rows_affected"`
	Row          []any `json:"row,omitempty"`
}

type BulkMutateOp struct {
	Schema     string     `json:"schema"`
	Object     string     `json:"object"`
	Operations []MutateOp `json:"operations"`
}

type BulkMutateResult struct {
	Applied      int    `json:"applied"`
	RowsAffected int64  `json:"rows_affected"`
	Message      string `json:"message"`
}
