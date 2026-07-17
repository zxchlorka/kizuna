package postgres

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/zxchlorka/kizuna/internal/connector"
)

const completionCacheTTL = 5 * time.Minute

var sqlKeywords = []string{
	"SELECT", "FROM", "WHERE", "JOIN", "LEFT", "RIGHT", "INNER", "OUTER", "ON", "AND", "OR", "NOT",
	"IN", "EXISTS", "GROUP BY", "ORDER BY", "HAVING", "LIMIT", "OFFSET", "INSERT", "UPDATE", "DELETE",
	"CREATE", "ALTER", "DROP", "INDEX", "TABLE", "COLUMN", "DISTINCT", "AS", "BETWEEN", "LIKE", "ILIKE",
	"IS NULL", "IS NOT NULL", "CASE", "WHEN", "THEN", "ELSE", "END", "UNION", "WITH", "RETURNING",
}

func (p *PostgresConnector) Completions(ctx context.Context, req connector.CompletionRequest) ([]connector.CompletionItem, error) {
	switch strings.ToLower(strings.TrimSpace(req.Context)) {
	case "table":
		return p.tableCompletions(ctx, req.Prefix)
	case "column":
		if strings.TrimSpace(req.Table) == "" {
			return nil, fmt.Errorf("%w: table is required for column context", connector.ErrBadRequest)
		}
		return p.columnCompletions(ctx, req.Table, req.Prefix)
	case "function":
		return p.functionCompletions(ctx, req.Prefix)
	case "", "keyword":
		return keywordCompletions(req.Prefix), nil
	default:
		return nil, fmt.Errorf("%w: unsupported completions context %q", connector.ErrBadRequest, req.Context)
	}
}

func (p *PostgresConnector) tableCompletions(ctx context.Context, prefix string) ([]connector.CompletionItem, error) {
	now := time.Now()

	p.completionMu.RLock()
	cached := p.tableCache
	expiresAt := p.tableCacheUntil
	p.completionMu.RUnlock()

	if now.Before(expiresAt) && len(cached) > 0 {
		return filterCompletionCache(cached, prefix, "table"), nil
	}

	rows, err := p.pool.Query(ctx, `
		SELECT table_schema, table_name, table_type
		FROM information_schema.tables
		WHERE table_schema NOT IN ('pg_catalog','information_schema')
	`)
	if err != nil {
		return nil, normalizePostgresError(err)
	}
	defer rows.Close()

	items := make([]completionCacheItem, 0)
	for rows.Next() {
		var schema, tableName, tableType string
		if err := rows.Scan(&schema, &tableName, &tableType); err != nil {
			return nil, normalizePostgresError(err)
		}
		items = append(items, completionCacheItem{
			label:  schema + "." + tableName,
			detail: tableType,
		})
	}
	if err := rows.Err(); err != nil {
		return nil, normalizePostgresError(err)
	}

	p.completionMu.Lock()
	p.tableCache = items
	p.tableCacheUntil = now.Add(completionCacheTTL)
	p.completionMu.Unlock()

	return filterCompletionCache(items, prefix, "table"), nil
}

func (p *PostgresConnector) columnCompletions(ctx context.Context, table string, prefix string) ([]connector.CompletionItem, error) {
	cacheKey := strings.ToLower(strings.TrimSpace(table))
	now := time.Now()

	p.completionMu.RLock()
	cached, ok := p.columnCache[cacheKey]
	p.completionMu.RUnlock()

	if ok && now.Before(cached.expires) {
		return filterCompletionCache(cached.items, prefix, "column"), nil
	}

	schema := ""
	tableName := strings.TrimSpace(table)
	if strings.Contains(tableName, ".") {
		var err error
		schema, tableName, err = parseSchemaTable(tableName)
		if err != nil {
			return nil, fmt.Errorf("%w: %v", connector.ErrBadRequest, err)
		}
	}

	rows, err := p.pool.Query(ctx, `
		WITH target_schema AS (
			SELECT ns.nspname
			FROM pg_catalog.pg_class cls
			JOIN pg_catalog.pg_namespace ns ON ns.oid = cls.relnamespace
			WHERE cls.relname = $1
			  AND cls.relkind IN ('r', 'p', 'v', 'm', 'f')
			  AND (($2 <> '' AND ns.nspname = $2) OR ($2 = '' AND ns.nspname = ANY (current_schemas(false))))
			ORDER BY
			  CASE
			    WHEN $2 <> '' THEN 0
			    ELSE array_position(current_schemas(false), ns.nspname)
			  END
			LIMIT 1
		)
		SELECT cols.column_name, cols.data_type
		FROM information_schema.columns AS cols
		JOIN target_schema AS target ON target.nspname = cols.table_schema
		WHERE cols.table_name = $1
		ORDER BY cols.ordinal_position
	`, tableName, schema)
	if err != nil {
		return nil, normalizePostgresError(err)
	}
	defer rows.Close()

	items := make([]completionCacheItem, 0)
	for rows.Next() {
		var label, detail string
		if err := rows.Scan(&label, &detail); err != nil {
			return nil, normalizePostgresError(err)
		}
		items = append(items, completionCacheItem{label: label, detail: detail})
	}
	if err := rows.Err(); err != nil {
		return nil, normalizePostgresError(err)
	}

	p.completionMu.Lock()
	p.columnCache[cacheKey] = completionCacheBucket{
		items:   items,
		expires: now.Add(completionCacheTTL),
	}
	p.completionMu.Unlock()

	return filterCompletionCache(items, prefix, "column"), nil
}

func (p *PostgresConnector) functionCompletions(ctx context.Context, prefix string) ([]connector.CompletionItem, error) {
	rows, err := p.pool.Query(ctx, `
		SELECT routine_name
		FROM information_schema.routines
		WHERE routine_schema NOT IN ('pg_catalog','information_schema')
		AND routine_name ILIKE $1 || '%'
		LIMIT 20
	`, strings.TrimSpace(prefix))
	if err != nil {
		return nil, normalizePostgresError(err)
	}
	defer rows.Close()

	items := make([]connector.CompletionItem, 0)
	for rows.Next() {
		var label string
		if err := rows.Scan(&label); err != nil {
			return nil, normalizePostgresError(err)
		}
		items = append(items, connector.CompletionItem{Label: label, Type: "function"})
	}
	if err := rows.Err(); err != nil {
		return nil, normalizePostgresError(err)
	}

	return items, nil
}

func keywordCompletions(prefix string) []connector.CompletionItem {
	needle := strings.ToUpper(strings.TrimSpace(prefix))
	items := make([]connector.CompletionItem, 0)
	for _, keyword := range sqlKeywords {
		if needle != "" && !strings.HasPrefix(keyword, needle) {
			continue
		}
		items = append(items, connector.CompletionItem{
			Label: keyword,
			Type:  "keyword",
		})
	}
	return items
}

func filterCompletionCache(items []completionCacheItem, prefix string, itemType string) []connector.CompletionItem {
	needle := strings.ToLower(strings.TrimSpace(prefix))
	out := make([]connector.CompletionItem, 0, len(items))
	for _, item := range items {
		if needle != "" && !matchesCompletionPrefix(item.label, needle) {
			continue
		}
		out = append(out, connector.CompletionItem{
			Label:  item.label,
			Type:   itemType,
			Detail: item.detail,
		})
	}
	return out
}

func matchesCompletionPrefix(label string, needle string) bool {
	qualified := strings.ToLower(label)
	if strings.HasPrefix(qualified, needle) {
		return true
	}

	_, bare, ok := strings.Cut(qualified, ".")
	return ok && !strings.Contains(needle, ".") && strings.HasPrefix(bare, needle)
}

func (p *PostgresConnector) invalidateCompletionCache() {
	p.completionMu.Lock()
	defer p.completionMu.Unlock()

	p.tableCache = nil
	p.tableCacheUntil = time.Time{}
	p.columnCache = make(map[string]completionCacheBucket)
	p.catalogCache = nil
	p.catalogCacheUntil = time.Time{}
}
