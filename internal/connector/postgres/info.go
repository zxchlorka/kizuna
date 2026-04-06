package postgres

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/qsnake66/infraview/internal/connector"
)

func (p *PostgresConnector) GetObjectInfo(ctx context.Context, object string) (*connector.ObjectInfo, error) {
	schema, name, err := parseSchemaTable(object)
	if err != nil {
		return nil, err
	}

	row := p.pool.QueryRow(ctx,
		`SELECT
			idx.relname AS index_name,
			tbl.relname AS owner_table,
			am.amname AS method,
			i.indisunique AS is_unique,
			pg_get_expr(i.indpred, i.indrelid) AS predicate,
			pg_get_indexdef(i.indexrelid) AS definition,
			COALESCE(
				array_agg(pg_get_indexdef(i.indexrelid, ord.ordinality, true) ORDER BY ord.ordinality)
					FILTER (WHERE ord.ordinality IS NOT NULL),
				'{}'::text[]
			) AS columns
		FROM pg_class idx
		JOIN pg_namespace ns ON ns.oid = idx.relnamespace
		JOIN pg_index i ON i.indexrelid = idx.oid
		JOIN pg_class tbl ON tbl.oid = i.indrelid
		JOIN pg_am am ON am.oid = idx.relam
		LEFT JOIN LATERAL generate_series(1, i.indnkeyatts) AS ord(ordinality) ON TRUE
		WHERE ns.nspname = $1
		  AND idx.relname = $2
		GROUP BY idx.relname, tbl.relname, am.amname, i.indisunique, i.indpred, i.indrelid, i.indexrelid`,
		schema, name,
	)

	info := &connector.ObjectInfo{
		Name:       name,
		Schema:     schema,
		ObjectType: "index",
	}

	if err := row.Scan(
		&info.Name,
		&info.OwnerTable,
		&info.Method,
		&info.IsUnique,
		&info.Predicate,
		&info.Definition,
		&info.Columns,
	); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, fmt.Errorf("%w: object %q not found", connector.ErrRelationNotFound, object)
		}
		return nil, normalizePostgresError(fmt.Errorf("failed to get object info: %w", err))
	}

	return info, nil
}
