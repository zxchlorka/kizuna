package postgres

import (
	"context"
	"time"

	"github.com/qsnake66/kizuna/internal/connector"
)

const (
	catalogCacheTTL  = 5 * time.Minute
	catalogColumnCap = 50000
)

type catalogRow struct {
	schema   string
	table    string
	column   string
	dataType string
}

// SQLCatalog implements connector.SQLCatalogProvider: one snapshot of every
// visible schema/table/column for editor autocomplete, cached like completions.
func (p *PostgresConnector) SQLCatalog(ctx context.Context) (*connector.SQLCatalog, error) {
	now := time.Now()

	p.completionMu.RLock()
	cached := p.catalogCache
	expiresAt := p.catalogCacheUntil
	p.completionMu.RUnlock()

	if cached != nil && now.Before(expiresAt) {
		return cached, nil
	}

	// pgx encodes a nil slice as SQL NULL, which would make the cardinality
	// check yield NULL and filter out every row; keep the array non-nil.
	visibleSchemas := p.config.VisibleSchemas
	if visibleSchemas == nil {
		visibleSchemas = []string{}
	}
	rows, err := p.pool.Query(ctx, `
		SELECT n.nspname, c.relname, a.attname, format_type(a.atttypid, a.atttypmod)
		FROM pg_catalog.pg_attribute a
		JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
		JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
		WHERE a.attnum > 0
		  AND NOT a.attisdropped
		  AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
		  AND n.nspname NOT IN ('pg_catalog', 'information_schema')
		  AND n.nspname NOT LIKE 'pg\_%'
		  AND (cardinality($1::text[]) = 0 OR n.nspname = ANY($1::text[]))
		ORDER BY n.nspname, c.relname, a.attnum
		LIMIT $2
	`, visibleSchemas, catalogColumnCap+1)
	if err != nil {
		return nil, normalizePostgresError(err)
	}
	defer rows.Close()

	entries := make([]catalogRow, 0, 256)
	for rows.Next() {
		var entry catalogRow
		if err := rows.Scan(&entry.schema, &entry.table, &entry.column, &entry.dataType); err != nil {
			return nil, normalizePostgresError(err)
		}
		entries = append(entries, entry)
	}
	if err := rows.Err(); err != nil {
		return nil, normalizePostgresError(err)
	}

	var defaultSchema string
	if err := p.pool.QueryRow(ctx, `SELECT COALESCE(current_schema(), 'public')`).Scan(&defaultSchema); err != nil {
		return nil, normalizePostgresError(err)
	}

	catalog := buildSQLCatalog(entries, defaultSchema, catalogColumnCap)

	p.completionMu.Lock()
	p.catalogCache = catalog
	p.catalogCacheUntil = now.Add(catalogCacheTTL)
	p.completionMu.Unlock()

	return catalog, nil
}

func buildSQLCatalog(entries []catalogRow, defaultSchema string, columnCap int) *connector.SQLCatalog {
	schemas := make(map[string]map[string][]connector.SQLCatalogColumn)
	truncated := false

	for index, entry := range entries {
		if index >= columnCap {
			truncated = true
			break
		}
		tables, ok := schemas[entry.schema]
		if !ok {
			tables = make(map[string][]connector.SQLCatalogColumn)
			schemas[entry.schema] = tables
		}
		tables[entry.table] = append(tables[entry.table], connector.SQLCatalogColumn{
			Name: entry.column,
			Type: entry.dataType,
		})
	}

	return &connector.SQLCatalog{
		Schemas:       schemas,
		DefaultSchema: defaultSchema,
		Truncated:     truncated,
	}
}
