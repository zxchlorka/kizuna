package postgres

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/zxchlorka/kizuna/internal/connector"
)

type sqlExecutor interface {
	Exec(ctx context.Context, sql string, arguments ...any) (pgconn.CommandTag, error)
	Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error)
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
}

type columnDef struct {
	Name       string
	DataType   string
	UDTName    string
	Nullable   bool
	HasDefault bool
}

func (p *PostgresConnector) Mutate(ctx context.Context, op connector.MutateOp) (*connector.MutateResult, error) {
	return p.mutateWithExecutor(ctx, p.pool, op)
}

func (p *PostgresConnector) MutateBulk(ctx context.Context, op connector.BulkMutateOp) (*connector.BulkMutateResult, error) {
	if op.Schema == "" || op.Object == "" {
		return nil, fmt.Errorf("%w: schema and object are required", connector.ErrBadRequest)
	}
	if len(op.Operations) == 0 {
		return nil, fmt.Errorf("%w: operations are required", connector.ErrBadRequest)
	}

	tx, err := p.pool.Begin(ctx)
	if err != nil {
		return nil, fmt.Errorf("begin tx failed: %w", err)
	}
	defer tx.Rollback(ctx)

	var (
		applied      int
		rowsAffected int64
	)

	for idx, item := range op.Operations {
		item.Schema = op.Schema
		item.Object = op.Object

		res, err := p.mutateWithExecutor(ctx, tx, item)
		if err != nil {
			return nil, fmt.Errorf("operation %d failed: %w", idx, err)
		}

		applied++
		rowsAffected += res.RowsAffected
	}

	if err := tx.Commit(ctx); err != nil {
		return nil, fmt.Errorf("commit failed: %w", err)
	}

	return &connector.BulkMutateResult{
		Applied:      applied,
		RowsAffected: rowsAffected,
		Message:      "bulk mutation applied",
	}, nil
}

func (p *PostgresConnector) mutateWithExecutor(ctx context.Context, exec sqlExecutor, op connector.MutateOp) (*connector.MutateResult, error) {
	if op.Schema == "" || op.Object == "" {
		return nil, fmt.Errorf("%w: schema and object are required", connector.ErrBadRequest)
	}

	schema, table, err := parseSchemaTable(op.Schema + "." + op.Object)
	if err != nil {
		return nil, fmt.Errorf("%w: invalid object: %v", connector.ErrBadRequest, err)
	}

	columns, pkCols, err := loadTableMeta(ctx, exec, schema, table)
	if err != nil {
		return nil, err
	}

	switch op.Type {
	case "update":
		return mutateUpdate(ctx, exec, schema, table, columns, pkCols, op)
	case "insert":
		return mutateInsert(ctx, exec, schema, table, columns, op)
	case "delete":
		return mutateDelete(ctx, exec, schema, table, columns, pkCols, op)
	default:
		return nil, fmt.Errorf("%w: unsupported mutate type %q", connector.ErrBadRequest, op.Type)
	}
}

func mutateUpdate(
	ctx context.Context,
	exec sqlExecutor,
	schema string,
	table string,
	columns map[string]columnDef,
	pkCols []string,
	op connector.MutateOp,
) (*connector.MutateResult, error) {
	if len(op.Data) == 0 {
		return nil, fmt.Errorf("%w: data is required for update", connector.ErrBadRequest)
	}
	if len(op.Where) == 0 {
		return nil, fmt.Errorf("%w: where is required for update", connector.ErrBadRequest)
	}
	if len(pkCols) == 0 {
		return nil, fmt.Errorf("%w: update requires table primary key", connector.ErrBadRequest)
	}
	if err := requirePKWhere(op.Where, pkCols); err != nil {
		return nil, err
	}

	dataCols := sortedKeys(op.Data)
	whereCols := sortedKeys(op.Where)

	setClauses := make([]string, 0, len(dataCols))
	whereClauses := make([]string, 0, len(whereCols))
	args := make([]any, 0, len(dataCols)+len(whereCols))
	param := 1

	for _, col := range dataCols {
		colDef, ok := columns[col]
		if !ok {
			return nil, fmt.Errorf("%w: unknown column %q", connector.ErrBadRequest, col)
		}
		v, err := coerceValue(op.Data[col], colDef)
		if err != nil {
			return nil, err
		}
		setClauses = append(setClauses, fmt.Sprintf("%s=$%d", pgx.Identifier{col}.Sanitize(), param))
		args = append(args, v)
		param++
	}

	for _, col := range whereCols {
		colDef, ok := columns[col]
		if !ok {
			return nil, fmt.Errorf("%w: unknown where column %q", connector.ErrBadRequest, col)
		}
		v, err := coerceValue(op.Where[col], colDef)
		if err != nil {
			return nil, err
		}
		whereClauses = append(whereClauses, fmt.Sprintf("%s=$%d", pgx.Identifier{col}.Sanitize(), param))
		args = append(args, v)
		param++
	}

	sql := fmt.Sprintf(
		"UPDATE %s SET %s WHERE %s",
		pgx.Identifier{schema, table}.Sanitize(),
		strings.Join(setClauses, ", "),
		strings.Join(whereClauses, " AND "),
	)

	tag, err := exec.Exec(ctx, sql, args...)
	if err != nil {
		return nil, mapPgError(err)
	}
	if tag.RowsAffected() == 0 {
		return nil, fmt.Errorf("%w: row not found", connector.ErrNotFound)
	}

	return &connector.MutateResult{RowsAffected: tag.RowsAffected()}, nil
}

func mutateInsert(
	ctx context.Context,
	exec sqlExecutor,
	schema string,
	table string,
	columns map[string]columnDef,
	op connector.MutateOp,
) (*connector.MutateResult, error) {
	cols := sortedKeys(op.Data)
	if len(cols) == 0 {
		return nil, fmt.Errorf("%w: data is required for insert", connector.ErrBadRequest)
	}

	idents := make([]string, 0, len(cols))
	placeholders := make([]string, 0, len(cols))
	args := make([]any, 0, len(cols))

	for idx, col := range cols {
		colDef, ok := columns[col]
		if !ok {
			return nil, fmt.Errorf("%w: unknown column %q", connector.ErrBadRequest, col)
		}
		v, err := coerceValue(op.Data[col], colDef)
		if err != nil {
			return nil, err
		}
		idents = append(idents, pgx.Identifier{col}.Sanitize())
		placeholders = append(placeholders, fmt.Sprintf("$%d", idx+1))
		args = append(args, v)
	}

	sql := fmt.Sprintf(
		"INSERT INTO %s (%s) VALUES (%s) RETURNING *",
		pgx.Identifier{schema, table}.Sanitize(),
		strings.Join(idents, ", "),
		strings.Join(placeholders, ", "),
	)

	rows, err := exec.Query(ctx, sql, args...)
	if err != nil {
		return nil, mapPgError(err)
	}
	defer rows.Close()

	var rowData []any
	if rows.Next() {
		rowData, err = rows.Values()
		if err != nil {
			return nil, fmt.Errorf("scan inserted row failed: %w", err)
		}
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("insert iteration failed: %w", err)
	}

	return &connector.MutateResult{RowsAffected: 1, Row: rowData}, nil
}

func mutateDelete(
	ctx context.Context,
	exec sqlExecutor,
	schema string,
	table string,
	columns map[string]columnDef,
	pkCols []string,
	op connector.MutateOp,
) (*connector.MutateResult, error) {
	if len(op.Where) == 0 {
		return nil, fmt.Errorf("%w: where is required for delete", connector.ErrBadRequest)
	}
	if len(pkCols) == 0 {
		return nil, fmt.Errorf("%w: delete requires table primary key", connector.ErrBadRequest)
	}
	if err := requirePKWhere(op.Where, pkCols); err != nil {
		return nil, err
	}

	whereCols := sortedKeys(op.Where)
	whereClauses := make([]string, 0, len(whereCols))
	args := make([]any, 0, len(whereCols))

	for idx, col := range whereCols {
		colDef, ok := columns[col]
		if !ok {
			return nil, fmt.Errorf("%w: unknown where column %q", connector.ErrBadRequest, col)
		}
		v, err := coerceValue(op.Where[col], colDef)
		if err != nil {
			return nil, err
		}
		whereClauses = append(whereClauses, fmt.Sprintf("%s=$%d", pgx.Identifier{col}.Sanitize(), idx+1))
		args = append(args, v)
	}

	sql := fmt.Sprintf(
		"DELETE FROM %s WHERE %s",
		pgx.Identifier{schema, table}.Sanitize(),
		strings.Join(whereClauses, " AND "),
	)

	tag, err := exec.Exec(ctx, sql, args...)
	if err != nil {
		return nil, mapPgError(err)
	}
	if tag.RowsAffected() == 0 {
		return nil, fmt.Errorf("%w: row not found", connector.ErrNotFound)
	}

	return &connector.MutateResult{RowsAffected: tag.RowsAffected()}, nil
}

func loadTableMeta(ctx context.Context, exec sqlExecutor, schema string, table string) (map[string]columnDef, []string, error) {
	rows, err := exec.Query(ctx,
		`SELECT column_name, data_type, udt_name, is_nullable, COALESCE(column_default, '')
		 FROM information_schema.columns
		 WHERE table_schema = $1 AND table_name = $2
		 ORDER BY ordinal_position`,
		schema, table,
	)
	if err != nil {
		return nil, nil, fmt.Errorf("load table columns failed: %w", err)
	}
	defer rows.Close()

	cols := make(map[string]columnDef)
	for rows.Next() {
		var (
			c          columnDef
			nullable   string
			defaultSQL string
		)
		if err := rows.Scan(&c.Name, &c.DataType, &c.UDTName, &nullable, &defaultSQL); err != nil {
			return nil, nil, fmt.Errorf("scan columns failed: %w", err)
		}
		c.Nullable = nullable == "YES"
		c.HasDefault = defaultSQL != ""
		cols[c.Name] = c
	}
	if err := rows.Err(); err != nil {
		return nil, nil, fmt.Errorf("columns rows failed: %w", err)
	}
	if len(cols) == 0 {
		return nil, nil, fmt.Errorf("%w: table %s.%s not found", connector.ErrBadRequest, schema, table)
	}

	pkRows, err := exec.Query(ctx,
		`SELECT kcu.column_name
		 FROM information_schema.table_constraints tc
		 JOIN information_schema.key_column_usage kcu
		   ON kcu.constraint_name = tc.constraint_name
		  AND kcu.table_schema = tc.table_schema
		 WHERE tc.table_schema = $1
		   AND tc.table_name = $2
		   AND tc.constraint_type = 'PRIMARY KEY'
		 ORDER BY kcu.ordinal_position`,
		schema, table,
	)
	if err != nil {
		return nil, nil, fmt.Errorf("load pk columns failed: %w", err)
	}
	defer pkRows.Close()

	var pkCols []string
	for pkRows.Next() {
		var name string
		if err := pkRows.Scan(&name); err != nil {
			return nil, nil, fmt.Errorf("scan pk column failed: %w", err)
		}
		pkCols = append(pkCols, name)
	}
	if err := pkRows.Err(); err != nil {
		return nil, nil, fmt.Errorf("pk rows failed: %w", err)
	}

	return cols, pkCols, nil
}

func requirePKWhere(where map[string]any, pkCols []string) error {
	if len(pkCols) == 0 {
		return fmt.Errorf("%w: primary key is required", connector.ErrBadRequest)
	}
	if len(where) != len(pkCols) {
		return fmt.Errorf("%w: where must contain exactly primary key columns", connector.ErrBadRequest)
	}

	for _, pk := range pkCols {
		if _, ok := where[pk]; !ok {
			return fmt.Errorf("%w: where must include primary key column %q", connector.ErrBadRequest, pk)
		}
	}
	return nil
}

func coerceValue(value any, col columnDef) (any, error) {
	if value == nil {
		if !col.Nullable {
			return nil, fmt.Errorf("%w: column %q is not nullable", connector.ErrBadRequest, col.Name)
		}
		return nil, nil
	}

	udt := strings.ToLower(col.UDTName)
	dataType := strings.ToLower(col.DataType)

	switch {
	case strings.HasPrefix(udt, "int"):
		return coerceInt(value, col.Name)
	case udt == "numeric" || udt == "decimal" || udt == "float4" || udt == "float8":
		return coerceFloat(value, col.Name)
	case udt == "bool":
		return coerceBool(value, col.Name)
	case udt == "uuid":
		return coerceUUID(value, col.Name)
	case udt == "date":
		return coerceDate(value, col.Name)
	case strings.HasPrefix(udt, "timestamp"):
		return coerceTimestamp(value, col.Name)
	case udt == "json" || udt == "jsonb":
		return coerceJSON(value, col.Name)
	case strings.Contains(dataType, "time"):
		return coerceTimeValue(value, col.Name)
	default:
		if s, ok := value.(string); ok {
			return s, nil
		}
		return fmt.Sprintf("%v", value), nil
	}
}

func coerceInt(v any, col string) (int64, error) {
	switch t := v.(type) {
	case int:
		return int64(t), nil
	case int8:
		return int64(t), nil
	case int16:
		return int64(t), nil
	case int32:
		return int64(t), nil
	case int64:
		return t, nil
	case float64:
		if t != float64(int64(t)) {
			return 0, fmt.Errorf("%w: column %q expects integer", connector.ErrBadRequest, col)
		}
		return int64(t), nil
	case json.Number:
		i, err := t.Int64()
		if err != nil {
			return 0, fmt.Errorf("%w: column %q expects integer", connector.ErrBadRequest, col)
		}
		return i, nil
	case string:
		i, err := strconv.ParseInt(strings.TrimSpace(t), 10, 64)
		if err != nil {
			return 0, fmt.Errorf("%w: column %q expects integer", connector.ErrBadRequest, col)
		}
		return i, nil
	default:
		return 0, fmt.Errorf("%w: column %q expects integer", connector.ErrBadRequest, col)
	}
}

func coerceFloat(v any, col string) (float64, error) {
	switch t := v.(type) {
	case float32:
		return float64(t), nil
	case float64:
		return t, nil
	case int, int8, int16, int32, int64:
		return strconv.ParseFloat(fmt.Sprintf("%v", t), 64)
	case json.Number:
		f, err := t.Float64()
		if err != nil {
			return 0, fmt.Errorf("%w: column %q expects numeric", connector.ErrBadRequest, col)
		}
		return f, nil
	case string:
		f, err := strconv.ParseFloat(strings.TrimSpace(t), 64)
		if err != nil {
			return 0, fmt.Errorf("%w: column %q expects numeric", connector.ErrBadRequest, col)
		}
		return f, nil
	default:
		return 0, fmt.Errorf("%w: column %q expects numeric", connector.ErrBadRequest, col)
	}
}

func coerceBool(v any, col string) (bool, error) {
	switch t := v.(type) {
	case bool:
		return t, nil
	case string:
		b, err := strconv.ParseBool(strings.TrimSpace(t))
		if err != nil {
			return false, fmt.Errorf("%w: column %q expects boolean", connector.ErrBadRequest, col)
		}
		return b, nil
	default:
		return false, fmt.Errorf("%w: column %q expects boolean", connector.ErrBadRequest, col)
	}
}

func coerceUUID(v any, col string) (string, error) {
	s, ok := v.(string)
	if !ok {
		return "", fmt.Errorf("%w: column %q expects uuid string", connector.ErrBadRequest, col)
	}
	s, ok = normalizeCanonicalUUID(s)
	if !ok {
		return "", fmt.Errorf("%w: column %q expects valid uuid", connector.ErrBadRequest, col)
	}
	return s, nil
}

func coerceDate(v any, col string) (time.Time, error) {
	s, ok := v.(string)
	if !ok {
		return time.Time{}, fmt.Errorf("%w: column %q expects date string YYYY-MM-DD", connector.ErrBadRequest, col)
	}
	tm, err := time.Parse("2006-01-02", strings.TrimSpace(s))
	if err != nil {
		return time.Time{}, fmt.Errorf("%w: column %q expects date string YYYY-MM-DD", connector.ErrBadRequest, col)
	}
	return tm, nil
}

func coerceTimestamp(v any, col string) (time.Time, error) {
	s, ok := v.(string)
	if !ok {
		return time.Time{}, fmt.Errorf("%w: column %q expects timestamp string", connector.ErrBadRequest, col)
	}
	s = strings.TrimSpace(s)
	layouts := []string{time.RFC3339Nano, time.RFC3339, "2006-01-02 15:04:05", "2006-01-02 15:04:05.999999"}
	for _, layout := range layouts {
		if tm, err := time.Parse(layout, s); err == nil {
			return tm, nil
		}
	}
	return time.Time{}, fmt.Errorf("%w: column %q expects timestamp string", connector.ErrBadRequest, col)
}

func coerceTimeValue(v any, col string) (string, error) {
	s, ok := v.(string)
	if !ok {
		return "", fmt.Errorf("%w: column %q expects time string", connector.ErrBadRequest, col)
	}
	s = strings.TrimSpace(s)
	if s == "" {
		return "", fmt.Errorf("%w: column %q expects time string", connector.ErrBadRequest, col)
	}
	return s, nil
}

func coerceJSON(v any, col string) (string, error) {
	if s, ok := v.(string); ok {
		s = strings.TrimSpace(s)
		if s == "" {
			return "", fmt.Errorf("%w: column %q expects valid json", connector.ErrBadRequest, col)
		}
		var tmp any
		if err := json.Unmarshal([]byte(s), &tmp); err != nil {
			return "", fmt.Errorf("%w: column %q expects valid json", connector.ErrBadRequest, col)
		}
		return s, nil
	}

	b, err := json.Marshal(v)
	if err != nil {
		return "", fmt.Errorf("%w: column %q expects valid json", connector.ErrBadRequest, col)
	}
	return string(b), nil
}

func mapPgError(err error) error {
	return normalizePostgresError(err)
}

// sortedKeys returns map keys sorted for deterministic SQL construction.
func sortedKeys(m map[string]any) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}
