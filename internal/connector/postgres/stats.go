package postgres

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
	"github.com/zxchlorka/kizuna/internal/connector"
)

// Server introspection is read-only and cheap, but it runs against a live
// server that may already be struggling — which is exactly when someone opens
// this screen. Every section is capped and deadlined so the diagnosis can never
// become part of the problem.
const (
	statsTimeout = 5 * time.Second
	statsMaxRows = 200
)

// SQLSTATEs that mean "the server can answer this, you may not ask" or "this
// server has no such thing" — both need naming rather than an empty table.
const (
	sqlStateInsufficientPrivilege = "42501"
	sqlStateUndefinedTable        = "42P01"
	sqlStateUndefinedFunction     = "42883"
)

// ServerStats implements connector.ServerStatsProvider.
func (p *PostgresConnector) ServerStats(ctx context.Context, section connector.ServerStatsSection) (*connector.DataResult, error) {
	query, ok := statsQueries[section]
	if !ok {
		return nil, fmt.Errorf("%w: unknown stats section %q", connector.ErrBadRequest, section)
	}

	ctx, cancel := context.WithTimeout(ctx, statsTimeout)
	defer cancel()

	result, err := p.queryStats(ctx, query.sql)
	if err != nil {
		return nil, explainStatsError(section, err)
	}
	result.Meta = map[string]any{"section": string(section), "hint": query.hint}
	if notice := redactionNotice(section, result); notice != "" {
		result.Meta["notice"] = notice
	}
	return result, nil
}

// Postgres redacts rather than refuses: a role without pg_read_all_stats still
// gets every row of pg_stat_statements, with the query text replaced by
// "<insufficient privilege>". Nothing errors, so without this the section is a
// wall of identical placeholders and no explanation of why.
func redactionNotice(section connector.ServerStatsSection, result *connector.DataResult) string {
	if section != connector.StatsStatements || len(result.Rows) == 0 {
		return ""
	}

	redacted := 0
	for _, row := range result.Rows {
		if text, ok := row["query"].(string); ok && strings.Contains(text, "insufficient privilege") {
			redacted++
		}
	}
	if redacted == 0 {
		return ""
	}

	return fmt.Sprintf(
		"%d of %d query texts are hidden: this role may only read its own. Granting pg_monitor "+
			"(or pg_read_all_stats) reveals the rest; the timings above are accurate either way.",
		redacted, len(result.Rows))
}

type statsQuery struct {
	sql string
	// hint travels with the rows and says what the numbers do NOT cover, so a
	// figure is never read as broader than it is.
	hint string
}

// queryStats runs one introspection query and shapes whatever it returns into
// the grid's format. Columns come from the result description rather than a
// hand-written list, so a query and its display can never drift apart.
func (p *PostgresConnector) queryStats(ctx context.Context, sql string) (*connector.DataResult, error) {
	rows, err := p.pool.Query(ctx, sql)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	columns := make([]connector.ColumnMeta, 0, len(rows.FieldDescriptions()))
	for _, field := range rows.FieldDescriptions() {
		columns = append(columns, connector.ColumnMeta{Name: field.Name, DataType: "text", Nullable: true})
	}

	resultRows := make([]map[string]any, 0, 32)
	for rows.Next() {
		values, err := rows.Values()
		if err != nil {
			return nil, err
		}
		resultRows = append(resultRows, buildResultRow(columns, values))
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}

	return &connector.DataResult{
		Columns: columns,
		Rows:    resultRows,
		Total:   int64(len(resultRows)),
		HasMore: len(resultRows) >= statsMaxRows,
	}, nil
}

// explainStatsError turns the two failures that are about the server's setup
// rather than about the query into something actionable. Postgres reports both
// as ordinary SQL errors, and "relation pg_stat_statements does not exist" does
// not tell a reader that an extension is missing, let alone which.
func explainStatsError(section connector.ServerStatsSection, err error) error {
	var pgErr *pgconn.PgError
	if !errors.As(err, &pgErr) {
		return normalizePostgresError(err)
	}

	switch pgErr.Code {
	case sqlStateUndefinedTable, sqlStateUndefinedFunction:
		if section == connector.StatsStatements {
			return fmt.Errorf(
				"%w: pg_stat_statements is not installed on this server. It has to be listed in "+
					"shared_preload_libraries and created with CREATE EXTENSION pg_stat_statements",
				connector.ErrBadRequest)
		}
		return normalizePostgresError(err)
	case sqlStateInsufficientPrivilege:
		return fmt.Errorf(
			"%w: this role may not read server-wide statistics. Granting pg_monitor "+
				"(or pg_read_all_stats) lets it see sessions and statements other than its own",
			connector.ErrForbidden)
	default:
		return normalizePostgresError(err)
	}
}

var statsQueries = map[connector.ServerStatsSection]statsQuery{
	// Activity answers "what is happening right now, and what is stuck behind
	// what". Idle-in-transaction sessions are included deliberately: they look
	// harmless because they are running nothing, while holding locks and keeping
	// autovacuum from cleaning up behind them.
	connector.StatsActivity: {
		hint: "Sessions on this server. A limited role sees only its own.",
		sql: `
			/* kizuna:stats */
			SELECT a.pid,
			       a.state,
			       a.usename                                   AS "user",
			       a.application_name                          AS application,
			       a.client_addr::text                         AS client,
			       date_trunc('second', now() - a.state_change)::text AS in_state,
			       date_trunc('second', now() - a.xact_start)::text   AS in_transaction,
			       a.wait_event_type                            AS wait_type,
			       a.wait_event,
			       NULLIF(array_to_string(pg_blocking_pids(a.pid), ', '), '') AS blocked_by,
			       left(regexp_replace(a.query, '\s+', ' ', 'g'), 200) AS query
			FROM pg_stat_activity a
			WHERE a.pid <> pg_backend_pid()
			  AND a.backend_type = 'client backend'
			  AND a.state IS NOT NULL
			  AND a.state <> 'idle'
			ORDER BY (pg_blocking_pids(a.pid) <> '{}') DESC,
			         a.xact_start NULLS LAST
			LIMIT 200`,
	},

	// The workload by cost. Ordered by total time rather than by mean: a query
	// taking 3ms and running ten million times is the one worth finding, and it
	// never surfaces in a list ordered by how slow a single call looks.
	connector.StatsStatements: {
		hint: "Since the last pg_stat_statements reset, not since server start.",
		sql: `
			/* kizuna:stats */
			SELECT round(s.total_exec_time)::bigint            AS total_ms,
			       s.calls,
			       round(s.mean_exec_time::numeric, 2)         AS mean_ms,
			       round(s.max_exec_time)::bigint              AS max_ms,
			       s.rows,
			       round(100 * s.total_exec_time
			             / NULLIF(sum(s.total_exec_time) OVER (), 0))::int AS pct_time,
			       left(regexp_replace(s.query, '\s+', ' ', 'g'), 300)     AS query
			FROM pg_stat_statements s
			-- Excludes the queries this screen runs. Without it Kizuna measures
			-- itself, tops its own ranking, and climbs with every Refresh. The
			-- marker is a literal in our own SQL, never user input.
			WHERE s.query NOT LIKE '%kizuna:stats%'
			ORDER BY s.total_exec_time DESC
			LIMIT 50`,
	},

	// Size and neglect side by side. A table is rarely interesting for its size
	// alone; it becomes interesting when it is large AND autovacuum has not been
	// near it, which is the pair that explains a slow table nobody changed.
	connector.StatsTables: {
		hint: "Dead-tuple counts are estimates maintained by the statistics collector.",
		sql: `
			/* kizuna:stats */
			SELECT s.schemaname || '.' || s.relname                       AS "table",
			       pg_size_pretty(pg_total_relation_size(c.oid))          AS total,
			       pg_size_pretty(pg_table_size(c.oid))                   AS data,
			       pg_size_pretty(pg_indexes_size(c.oid))                 AS indexes,
			       s.n_live_tup                                           AS live_rows,
			       s.n_dead_tup                                           AS dead_rows,
			       -- Share of the table's row versions that are dead, not the
			       -- dead-to-live ratio: a table with 4 live and 11 dead rows is
			       -- 73% dead, and reporting 275% reads as a broken number.
			       CASE WHEN s.n_live_tup + s.n_dead_tup > 0
			            THEN round(100.0 * s.n_dead_tup / (s.n_live_tup + s.n_dead_tup))::int
			       END                                                    AS dead_pct,
			       date_trunc('second', GREATEST(s.last_autovacuum, s.last_vacuum)) AS last_vacuum,
			       date_trunc('second', GREATEST(s.last_autoanalyze, s.last_analyze)) AS last_analyze
			FROM pg_stat_user_tables s
			JOIN pg_class c ON c.oid = s.relid
			ORDER BY pg_total_relation_size(c.oid) DESC
			LIMIT 200`,
	},

	// An index nothing reads still costs a write on every insert and update, and
	// still occupies its disk. Ordered by size, because that is what dropping it
	// gives back.
	connector.StatsIndexes: {
		hint: "Scan counts are since the last statistics reset — a fresh zero means unknown, not unused.",
		sql: `
			/* kizuna:stats */
			SELECT s.schemaname || '.' || s.relname                  AS "table",
			       s.indexrelname                                    AS index,
			       pg_size_pretty(pg_relation_size(s.indexrelid))    AS size,
			       s.idx_scan                                        AS scans,
			       date_trunc('second', st.stats_reset)              AS stats_since,
			       i.indisunique                                     AS is_unique
			FROM pg_stat_user_indexes s
			JOIN pg_index i ON i.indexrelid = s.indexrelid
			LEFT JOIN pg_stat_database st ON st.datname = current_database()
			WHERE s.idx_scan = 0
			  AND NOT i.indisprimary
			  AND NOT i.indisunique
			ORDER BY pg_relation_size(s.indexrelid) DESC
			LIMIT 200`,
	},

	// A sequence feeding an integer column stops at 2147483647, and the inserts
	// simply start failing. The ceiling comes from the COLUMN, not the sequence:
	// pg_sequences reports max_value as 2^63 for almost everything, so reading it
	// alone reports 0% used on a sequence with a week to live.
	connector.StatsSequences: {
		hint: "Headroom is measured against the column's type, not the sequence's own max_value.",
		sql: `
			/* kizuna:stats */
			WITH owned AS (
			    SELECT c.oid                        AS seq_oid,
			           n.nspname || '.' || c.relname AS sequence,
			           dc.relname                    AS "table",
			           a.attname                     AS column,
			           format_type(a.atttypid, NULL) AS column_type,
			           CASE a.atttypid
			               WHEN 'smallint'::regtype THEN 32767::bigint
			               WHEN 'integer'::regtype  THEN 2147483647::bigint
			               ELSE 9223372036854775807::bigint
			           END                           AS ceiling
			    FROM pg_class c
			    JOIN pg_namespace n ON n.oid = c.relnamespace
			    JOIN pg_depend d ON d.objid = c.oid AND d.classid = 'pg_class'::regclass
			    JOIN pg_class dc ON dc.oid = d.refobjid
			    JOIN pg_attribute a ON a.attrelid = d.refobjid AND a.attnum = d.refobjsubid
			    WHERE c.relkind = 'S' AND d.deptype IN ('a', 'i')
			)
			SELECT o.sequence,
			       o."table" || '.' || o.column AS feeds,
			       o.column_type,
			       s.last_value,
			       o.ceiling                    AS max_value,
			       round(100.0 * COALESCE(s.last_value, 0) / o.ceiling, 2) AS pct_used
			FROM owned o
			JOIN pg_sequences s
			  ON s.schemaname || '.' || s.sequencename = o.sequence
			ORDER BY 100.0 * COALESCE(s.last_value, 0) / o.ceiling DESC
			LIMIT 200`,
	},

	// Replication lag in bytes and in time. Bytes answer "how far behind", the
	// time columns answer "how long behind" — a replica can be a few megabytes
	// behind for a second or for an hour, and only the second one is an outage.
	connector.StatsReplication: {
		hint: "Rows appear on a primary with connected replicas; a replica reports none.",
		sql: `
			/* kizuna:stats */
			SELECT r.application_name                       AS replica,
			       r.client_addr::text                      AS client,
			       r.state,
			       r.sync_state,
			       pg_size_pretty(
			           pg_wal_lsn_diff(pg_current_wal_lsn(), r.replay_lsn)) AS behind,
			       date_trunc('second', r.write_lag)::text  AS write_lag,
			       date_trunc('second', r.flush_lag)::text  AS flush_lag,
			       date_trunc('second', r.replay_lag)::text AS replay_lag
			FROM pg_stat_replication r
			ORDER BY pg_wal_lsn_diff(pg_current_wal_lsn(), r.replay_lsn) DESC
			LIMIT 200`,
	},
}
