package postgres

import (
	"context"
	"fmt"
	"strings"
	"sync"

	"github.com/jackc/pgx/v5"
	"github.com/qsnake66/infraview/internal/connector"
)

func buildResultRow(columns []connector.ColumnMeta, values []any) map[string]any {
	row := make(map[string]any, len(columns))
	for idx, column := range columns {
		if idx < len(values) {
			row[column.Name] = values[idx]
			continue
		}
		row[column.Name] = nil
	}
	return row
}

func (p *PostgresConnector) GetData(ctx context.Context, object string, opts connector.DataOpts) (*connector.DataResult, error) {
	schema, table, err := parseSchemaTable(object)
	if err != nil {
		return nil, fmt.Errorf("%w: %v", connector.ErrBadRequest, err)
	}

	// Fetch schema to get column metadata
	schemaResult, err := p.GetSchema(ctx, object)
	if err != nil {
		return nil, fmt.Errorf("failed to get schema for %s: %w", object, err)
	}

	// Build column name set for validation
	colSet := make(map[string]bool, len(schemaResult.Columns))
	selectCols := make([]string, 0, len(schemaResult.Columns))
	for _, col := range schemaResult.Columns {
		colSet[col.Name] = true
		quotedCol := pgx.Identifier{col.Name}.Sanitize()
		// Keep API contract stable: UUID is always serialized as canonical text.
		if strings.EqualFold(col.DataType, "uuid") {
			selectCols = append(selectCols, fmt.Sprintf("%s::text AS %s", quotedCol, quotedCol))
			continue
		}
		selectCols = append(selectCols, quotedCol)
	}
	if len(selectCols) == 0 {
		return nil, fmt.Errorf("%w: table %s has no columns", connector.ErrBadRequest, object)
	}

	// Normalize limit
	limit := opts.Limit
	if limit <= 0 {
		limit = 50
	}
	if limit > 1000 {
		limit = 1000
	}
	offset := opts.Offset
	if offset < 0 {
		offset = 0
	}

	// Build WHERE clause
	var whereParts []string
	var args []any
	paramIdx := 1

	for _, f := range opts.Filters {
		if !colSet[f.Column] {
			return nil, fmt.Errorf("%w: unknown filter column %q", connector.ErrBadRequest, f.Column)
		}
		quotedCol := pgx.Identifier{f.Column}.Sanitize()

		switch f.Op {
		case "eq":
			whereParts = append(whereParts, fmt.Sprintf("%s = $%d", quotedCol, paramIdx))
			args = append(args, f.Value)
			paramIdx++
		case "neq":
			whereParts = append(whereParts, fmt.Sprintf("%s != $%d", quotedCol, paramIdx))
			args = append(args, f.Value)
			paramIdx++
		case "gt":
			whereParts = append(whereParts, fmt.Sprintf("%s > $%d", quotedCol, paramIdx))
			args = append(args, f.Value)
			paramIdx++
		case "gte":
			whereParts = append(whereParts, fmt.Sprintf("%s >= $%d", quotedCol, paramIdx))
			args = append(args, f.Value)
			paramIdx++
		case "lt":
			whereParts = append(whereParts, fmt.Sprintf("%s < $%d", quotedCol, paramIdx))
			args = append(args, f.Value)
			paramIdx++
		case "lte":
			whereParts = append(whereParts, fmt.Sprintf("%s <= $%d", quotedCol, paramIdx))
			args = append(args, f.Value)
			paramIdx++
		case "like":
			whereParts = append(whereParts, fmt.Sprintf("%s ILIKE $%d", quotedCol, paramIdx))
			args = append(args, f.Value)
			paramIdx++
		case "contains":
			whereParts = append(whereParts, fmt.Sprintf("%s ILIKE $%d", quotedCol, paramIdx))
			args = append(args, "%"+f.Value+"%")
			paramIdx++
		case "is_null":
			whereParts = append(whereParts, fmt.Sprintf("%s IS NULL", quotedCol))
		case "is_not_null":
			whereParts = append(whereParts, fmt.Sprintf("%s IS NOT NULL", quotedCol))
		default:
			return nil, fmt.Errorf("%w: unknown filter op %q", connector.ErrBadRequest, f.Op)
		}
	}

	tableRef := pgx.Identifier{schema, table}.Sanitize()

	whereClause := ""
	if len(whereParts) > 0 {
		whereClause = " WHERE " + strings.Join(whereParts, " AND ")
	}

	// Build ORDER BY clause
	orderClause := ""
	if opts.OrderBy != "" {
		if !colSet[opts.OrderBy] {
			return nil, fmt.Errorf("%w: unknown order_by column %q", connector.ErrBadRequest, opts.OrderBy)
		}
		dir := strings.ToLower(opts.OrderDir)
		if dir != "asc" && dir != "desc" {
			dir = "asc"
		}
		orderClause = fmt.Sprintf(" ORDER BY %s %s", pgx.Identifier{opts.OrderBy}.Sanitize(), dir)
	}

	countSQL := fmt.Sprintf("SELECT count(*) FROM %s%s", tableRef, whereClause)
	dataSQL := fmt.Sprintf("SELECT %s FROM %s%s%s LIMIT %d OFFSET %d",
		strings.Join(selectCols, ", "),
		tableRef, whereClause, orderClause, limit, offset)

	// Run count query in parallel
	var total int64
	var countErr error
	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		countErr = p.pool.QueryRow(ctx, countSQL, args...).Scan(&total)
	}()

	// Run data query
	rows, err := p.pool.Query(ctx, dataSQL, args...)
	if err != nil {
		wg.Wait()
		return nil, fmt.Errorf("failed to query data: %w", err)
	}
	defer rows.Close()

	var resultRows []map[string]any
	for rows.Next() {
		vals, err := rows.Values()
		if err != nil {
			wg.Wait()
			return nil, fmt.Errorf("failed to scan row: %w", err)
		}
		resultRows = append(resultRows, buildResultRow(schemaResult.Columns, vals))
	}
	if err := rows.Err(); err != nil {
		wg.Wait()
		return nil, fmt.Errorf("row iteration error: %w", err)
	}

	wg.Wait()
	if countErr != nil {
		return nil, fmt.Errorf("failed to count rows: %w", countErr)
	}

	hasMore := int64(offset+len(resultRows)) < total

	return &connector.DataResult{
		Columns: schemaResult.Columns,
		Rows:    resultRows,
		Total:   total,
		HasMore: hasMore,
	}, nil
}
