package postgres

import (
	"context"
	"fmt"
	"strings"

	"github.com/qsnake66/infraview/internal/connector"
)

func (p *PostgresConnector) ListObjects(ctx context.Context, path string) ([]connector.Object, error) {
	if path == "" {
		return p.listSchemas(ctx)
	}
	return p.listTables(ctx, path)
}

func (p *PostgresConnector) listSchemas(ctx context.Context) ([]connector.Object, error) {
	rows, err := p.pool.Query(ctx,
		`SELECT schema_name FROM information_schema.schemata
		 WHERE schema_name NOT IN ('pg_catalog','information_schema','pg_toast')
		 ORDER BY schema_name`)
	if err != nil {
		return nil, normalizePostgresError(fmt.Errorf("failed to list schemas: %w", err))
	}
	defer rows.Close()

	var objects []connector.Object
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			return nil, normalizePostgresError(err)
		}
		objects = append(objects, connector.Object{
			Name: name,
			Type: "schema",
		})
	}
	return objects, normalizePostgresError(rows.Err())
}

func (p *PostgresConnector) listTables(ctx context.Context, schema string) ([]connector.Object, error) {
	rows, err := p.pool.Query(ctx,
		`SELECT DISTINCT name, type, row_count, parent_name
		 FROM (
		 	SELECT
		 		t.table_name AS name,
		 		LOWER(t.table_type) AS type,
		 		COALESCE(s.n_live_tup, 0)::bigint AS row_count,
		 		NULL::text AS parent_name
		 	FROM information_schema.tables t
		 	LEFT JOIN pg_stat_user_tables s
		 	    ON s.schemaname = t.table_schema AND s.relname = t.table_name
		 	WHERE t.table_schema = $1

		 	UNION ALL

		 	SELECT
		 		i.indexname AS name,
		 		'index' AS type,
		 		0::bigint AS row_count,
		 		i.tablename AS parent_name
		 	FROM pg_indexes i
		 	WHERE i.schemaname = $1
		 ) objects
		 ORDER BY type, name`, schema)
	if err != nil {
		return nil, normalizePostgresError(fmt.Errorf("failed to list tables: %w", err))
	}
	defer rows.Close()

	var objects []connector.Object
	for rows.Next() {
		var name, tableType string
		var rowCount int64
		var parentName *string
		if err := rows.Scan(&name, &tableType, &rowCount, &parentName); err != nil {
			return nil, normalizePostgresError(err)
		}
		parent := ""
		if parentName != nil {
			parent = *parentName
		}
		objects = append(objects, connector.Object{
			Name:       name,
			Type:       normalizeObjectType(tableType),
			Schema:     schema,
			RowCount:   rowCount,
			ParentName: parent,
		})
	}
	if err := rows.Err(); err != nil {
		return nil, normalizePostgresError(err)
	}
	return objects, nil
}

func (p *PostgresConnector) GetSchema(ctx context.Context, object string) (*connector.Schema, error) {
	schema, table, err := parseSchemaTable(object)
	if err != nil {
		return nil, err
	}

	rows, err := p.pool.Query(ctx,
		`SELECT
			column_name,
			data_type,
			is_nullable,
			column_default
		FROM information_schema.columns
		WHERE table_name = $1 AND table_schema = $2
		ORDER BY ordinal_position`, table, schema)
	if err != nil {
		return nil, normalizePostgresError(fmt.Errorf("failed to get schema: %w", err))
	}
	defer rows.Close()

	var columns []connector.ColumnMeta
	indexByName := make(map[string]int)
	for rows.Next() {
		var col connector.ColumnMeta
		var nullable string
		var colDefault *string

		if err := rows.Scan(&col.Name, &col.DataType, &nullable, &colDefault); err != nil {
			return nil, normalizePostgresError(err)
		}

		col.Nullable = nullable == "YES"
		col.Default = colDefault

		indexByName[col.Name] = len(columns)
		columns = append(columns, col)
	}
	if err := rows.Err(); err != nil {
		return nil, normalizePostgresError(err)
	}
	if len(columns) == 0 {
		return &connector.Schema{Columns: columns}, nil
	}

	pkRows, err := p.pool.Query(ctx,
		`SELECT kcu.column_name
		 FROM information_schema.table_constraints tc
		 JOIN information_schema.key_column_usage kcu
		   ON kcu.constraint_name = tc.constraint_name
		  AND kcu.table_schema = tc.table_schema
		 WHERE tc.table_schema = $1
		   AND tc.table_name = $2
		   AND tc.constraint_type = 'PRIMARY KEY'
		 ORDER BY kcu.ordinal_position`, schema, table)
	if err != nil {
		return nil, normalizePostgresError(fmt.Errorf("failed to get primary keys: %w", err))
	}
	defer pkRows.Close()

	for pkRows.Next() {
		var colName string
		if err := pkRows.Scan(&colName); err != nil {
			return nil, normalizePostgresError(err)
		}
		if idx, ok := indexByName[colName]; ok {
			columns[idx].IsPK = true
		}
	}
	if err := pkRows.Err(); err != nil {
		return nil, normalizePostgresError(err)
	}

	fkRows, err := p.pool.Query(ctx,
		`SELECT
			kcu.column_name,
			ccu.table_name,
			ccu.column_name
		 FROM information_schema.table_constraints tc
		 JOIN information_schema.key_column_usage kcu
		   ON kcu.constraint_name = tc.constraint_name
		  AND kcu.table_schema = tc.table_schema
		 JOIN information_schema.referential_constraints rc
		   ON rc.constraint_name = tc.constraint_name
		  AND rc.constraint_schema = tc.table_schema
		 JOIN information_schema.constraint_column_usage ccu
		   ON ccu.constraint_name = rc.unique_constraint_name
		  AND ccu.constraint_schema = rc.unique_constraint_schema
		 WHERE tc.table_schema = $1
		   AND tc.table_name = $2
		   AND tc.constraint_type = 'FOREIGN KEY'`, schema, table)
	if err != nil {
		return nil, normalizePostgresError(fmt.Errorf("failed to get foreign keys: %w", err))
	}
	defer fkRows.Close()

	for fkRows.Next() {
		var (
			colName  string
			fkTable  string
			fkColumn string
		)
		if err := fkRows.Scan(&colName, &fkTable, &fkColumn); err != nil {
			return nil, normalizePostgresError(err)
		}
		if idx, ok := indexByName[colName]; ok {
			columns[idx].IsFK = true
			columns[idx].FKTable = fkTable
			columns[idx].FKColumn = fkColumn
		}
	}
	if err := fkRows.Err(); err != nil {
		return nil, normalizePostgresError(err)
	}

	return &connector.Schema{Columns: columns}, nil
}

// parseSchemaTable splits "schema.table" into schema and table parts.
func parseSchemaTable(object string) (string, string, error) {
	parts := strings.SplitN(object, ".", 2)
	if len(parts) != 2 {
		return "", "", fmt.Errorf("invalid object name %q: expected schema.table", object)
	}
	return parts[0], parts[1], nil
}

func normalizeObjectType(tableType string) string {
	switch strings.ToLower(tableType) {
	case "base table":
		return "table"
	case "view":
		return "view"
	default:
		return strings.ToLower(tableType)
	}
}
