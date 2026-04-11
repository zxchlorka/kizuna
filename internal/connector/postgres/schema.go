package postgres

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/qsnake66/infraview/internal/connector"
)

const objectCacheTTL = 15 * time.Second

func (p *PostgresConnector) ListObjects(ctx context.Context, path string) ([]connector.Object, error) {
	if path == "" {
		if items, ok := p.cachedRootObjects(); ok {
			return items, nil
		}

		items, err := p.listSchemas(ctx)
		if err != nil {
			return nil, err
		}
		p.storeRootObjects(items)
		return cloneObjects(items), nil
	}

	if items, ok := p.cachedChildObjects(path); ok {
		return items, nil
	}

	items, err := p.listTables(ctx, path)
	if err != nil {
		return nil, err
	}
	p.storeChildObjects(path, items)
	return cloneObjects(items), nil
}

func (p *PostgresConnector) listSchemas(ctx context.Context) ([]connector.Object, error) {
	rows, err := p.pool.Query(ctx,
		`SELECT schema_name FROM information_schema.schemata
		 WHERE schema_name NOT IN ('pg_catalog','information_schema','pg_toast')
		   AND schema_name NOT LIKE 'pg_temp_%'
		   AND schema_name NOT LIKE 'pg_toast_temp_%'
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
		`SELECT name, type, row_count, parent_name
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

func (p *PostgresConnector) invalidateObjectCache() {
	p.objectCacheMu.Lock()
	defer p.objectCacheMu.Unlock()

	p.rootObjectCache = objectCacheBucket{}
	p.childObjectCache = make(map[string]objectCacheBucket)
}

func (p *PostgresConnector) cachedRootObjects() ([]connector.Object, bool) {
	p.objectCacheMu.RLock()
	defer p.objectCacheMu.RUnlock()

	if time.Now().After(p.rootObjectCache.expires) || len(p.rootObjectCache.items) == 0 {
		return nil, false
	}
	return cloneObjects(p.rootObjectCache.items), true
}

func (p *PostgresConnector) storeRootObjects(items []connector.Object) {
	p.objectCacheMu.Lock()
	defer p.objectCacheMu.Unlock()

	p.rootObjectCache = objectCacheBucket{
		items:   cloneObjects(items),
		expires: time.Now().Add(objectCacheTTL),
	}
}

func (p *PostgresConnector) cachedChildObjects(path string) ([]connector.Object, bool) {
	p.objectCacheMu.RLock()
	defer p.objectCacheMu.RUnlock()

	bucket, ok := p.childObjectCache[path]
	if !ok || time.Now().After(bucket.expires) {
		return nil, false
	}
	return cloneObjects(bucket.items), true
}

func (p *PostgresConnector) storeChildObjects(path string, items []connector.Object) {
	p.objectCacheMu.Lock()
	defer p.objectCacheMu.Unlock()

	p.childObjectCache[path] = objectCacheBucket{
		items:   cloneObjects(items),
		expires: time.Now().Add(objectCacheTTL),
	}
}

func cloneObjects(items []connector.Object) []connector.Object {
	cloned := make([]connector.Object, len(items))
	copy(cloned, items)
	return cloned
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
			ccu.table_schema,
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
			fkSchema string
			fkTable  string
			fkColumn string
		)
		if err := fkRows.Scan(&colName, &fkSchema, &fkTable, &fkColumn); err != nil {
			return nil, normalizePostgresError(err)
		}
		if idx, ok := indexByName[colName]; ok {
			columns[idx].IsFK = true
			columns[idx].FKTable = fmt.Sprintf("%s.%s", fkSchema, fkTable)
			columns[idx].FKColumn = fkColumn
		}
	}
	if err := fkRows.Err(); err != nil {
		return nil, normalizePostgresError(err)
	}

	referencedByRows, err := p.pool.Query(ctx,
		`SELECT
			src_kcu.table_schema,
			src_kcu.table_name,
			src_kcu.column_name,
			tgt_ccu.column_name
		 FROM information_schema.referential_constraints rc
		 JOIN information_schema.key_column_usage src_kcu
		   ON src_kcu.constraint_name = rc.constraint_name
		  AND src_kcu.constraint_schema = rc.constraint_schema
		 JOIN information_schema.constraint_column_usage tgt_ccu
		   ON tgt_ccu.constraint_name = rc.unique_constraint_name
		  AND tgt_ccu.constraint_schema = rc.unique_constraint_schema
		 WHERE tgt_ccu.table_schema = $1
		   AND tgt_ccu.table_name = $2
		 ORDER BY src_kcu.table_schema, src_kcu.table_name, src_kcu.column_name`, schema, table)
	if err != nil {
		return nil, normalizePostgresError(fmt.Errorf("failed to get referenced by metadata: %w", err))
	}
	defer referencedByRows.Close()

	referencedBy := make([]connector.FKRef, 0)
	for referencedByRows.Next() {
		var (
			sourceSchema string
			sourceTable  string
			sourceColumn string
			targetColumn string
		)
		if err := referencedByRows.Scan(&sourceSchema, &sourceTable, &sourceColumn, &targetColumn); err != nil {
			return nil, normalizePostgresError(err)
		}
		referencedBy = append(referencedBy, connector.FKRef{
			Table:     fmt.Sprintf("%s.%s", sourceSchema, sourceTable),
			Column:    sourceColumn,
			RefColumn: targetColumn,
		})
	}
	if err := referencedByRows.Err(); err != nil {
		return nil, normalizePostgresError(err)
	}

	return &connector.Schema{Columns: columns, ReferencedBy: referencedBy}, nil
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
