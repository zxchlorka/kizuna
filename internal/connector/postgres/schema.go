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
		return nil, fmt.Errorf("failed to list schemas: %w", err)
	}
	defer rows.Close()

	var objects []connector.Object
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			return nil, err
		}
		objects = append(objects, connector.Object{
			Name: name,
			Type: "schema",
		})
	}
	return objects, rows.Err()
}

func (p *PostgresConnector) listTables(ctx context.Context, schema string) ([]connector.Object, error) {
	rows, err := p.pool.Query(ctx,
		`SELECT t.table_name, t.table_type, COALESCE(s.n_live_tup, 0)
		 FROM information_schema.tables t
		 LEFT JOIN pg_stat_user_tables s
		     ON s.schemaname = t.table_schema AND s.relname = t.table_name
		 WHERE t.table_schema = $1
		 ORDER BY t.table_name`, schema)
	if err != nil {
		return nil, fmt.Errorf("failed to list tables: %w", err)
	}
	defer rows.Close()

	var objects []connector.Object
	for rows.Next() {
		var name, tableType string
		var rowCount int64
		if err := rows.Scan(&name, &tableType, &rowCount); err != nil {
			return nil, err
		}
		objects = append(objects, connector.Object{
			Name:     name,
			Type:     tableType,
			Schema:   schema,
			RowCount: rowCount,
		})
	}
	return objects, rows.Err()
}

func (p *PostgresConnector) GetSchema(ctx context.Context, object string) (*connector.Schema, error) {
	schema, table, err := parseSchemaTable(object)
	if err != nil {
		return nil, err
	}

	rows, err := p.pool.Query(ctx,
		`SELECT
			c.column_name,
			c.data_type,
			c.is_nullable,
			c.column_default,
			COALESCE(tc.constraint_type, '') as constraint_type,
			COALESCE(ccu.table_name, '') as fk_table,
			COALESCE(ccu.column_name, '') as fk_column
		FROM information_schema.columns c
		LEFT JOIN information_schema.key_column_usage kcu
			ON kcu.table_name = c.table_name
			AND kcu.table_schema = c.table_schema
			AND kcu.column_name = c.column_name
		LEFT JOIN information_schema.table_constraints tc
			ON tc.constraint_name = kcu.constraint_name
			AND tc.table_schema = c.table_schema
		LEFT JOIN information_schema.referential_constraints rc
			ON rc.constraint_name = kcu.constraint_name
		LEFT JOIN information_schema.constraint_column_usage ccu
			ON ccu.constraint_name = rc.unique_constraint_name
		WHERE c.table_name = $1 AND c.table_schema = $2
		ORDER BY c.ordinal_position`, table, schema)
	if err != nil {
		return nil, fmt.Errorf("failed to get schema: %w", err)
	}
	defer rows.Close()

	var columns []connector.ColumnMeta
	for rows.Next() {
		var col connector.ColumnMeta
		var nullable, constraintType, fkTable, fkColumn string
		var colDefault *string

		if err := rows.Scan(&col.Name, &col.DataType, &nullable, &colDefault,
			&constraintType, &fkTable, &fkColumn); err != nil {
			return nil, err
		}

		col.Nullable = nullable == "YES"
		col.Default = colDefault
		col.IsPK = constraintType == "PRIMARY KEY"
		col.IsFK = constraintType == "FOREIGN KEY"
		col.FKTable = fkTable
		col.FKColumn = fkColumn

		columns = append(columns, col)
	}
	if err := rows.Err(); err != nil {
		return nil, err
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
