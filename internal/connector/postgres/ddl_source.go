package postgres

import (
	"context"
	"errors"
	"fmt"
	"math"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/zxchlorka/kizuna/internal/connector"
)

var _ connector.DDLSourceProvider = (*PostgresConnector)(nil)

// ObjectDDL rebuilds the CREATE statement for a table, view or materialized
// view from the catalog. Postgres has no server-side "show create table", so
// columns are assembled here while every piece Postgres can print itself
// (constraints, indexes, view bodies, partition keys) comes from its pg_get_*
// functions verbatim — those already quote and qualify exactly as the server
// would parse them back.
//
// Out of scope by design: triggers, grants, comments, ownership and the
// PARTITION OF clause of individual partitions.
func (p *PostgresConnector) ObjectDDL(ctx context.Context, object string) (string, error) {
	schema, name, err := parseSchemaTable(object)
	if err != nil {
		return "", err
	}

	// With an empty search path the pg_get_* functions qualify every name they
	// print, as pg_dump does, so the output means the same thing wherever it is
	// pasted. SET LOCAL needs a transaction; read-only, and rolled back anyway.
	tx, err := p.pool.BeginTx(ctx, pgx.TxOptions{AccessMode: pgx.ReadOnly})
	if err != nil {
		return "", normalizePostgresError(fmt.Errorf("failed to begin: %w", err))
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SET LOCAL search_path = pg_catalog`); err != nil {
		return "", normalizePostgresError(fmt.Errorf("failed to set search path: %w", err))
	}

	var (
		oid       uint32
		kind      string
		qualified string
		options   *string
	)
	err = tx.QueryRow(ctx,
		`SELECT c.oid, c.relkind::text, format('%I.%I', n.nspname, c.relname), array_to_string(c.reloptions, ', ')
		FROM pg_class c
		JOIN pg_namespace n ON n.oid = c.relnamespace
		WHERE n.nspname = $1 AND c.relname = $2 AND c.relkind IN ('r', 'p', 'v', 'm')`,
		schema, name,
	).Scan(&oid, &kind, &qualified, &options)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return "", fmt.Errorf("%w: table or view %q not found", connector.ErrRelationNotFound, object)
		}
		return "", normalizePostgresError(fmt.Errorf("failed to look up object: %w", err))
	}

	// Storage parameters, and for views security_invoker, security_barrier and
	// check_option: dropping those turns an invoker-rights view into one that
	// reads with its owner's rights.
	with := ""
	if options != nil && *options != "" {
		with = " WITH (" + *options + ")"
	}

	var b strings.Builder
	switch kind {
	case "v", "m":
		var body string
		if err := tx.QueryRow(ctx, `SELECT pg_get_viewdef($1::oid, true)`, oid).Scan(&body); err != nil {
			return "", normalizePostgresError(fmt.Errorf("failed to read view definition: %w", err))
		}
		keyword := "VIEW"
		if kind == "m" {
			keyword = "MATERIALIZED VIEW"
		}
		fmt.Fprintf(&b, "CREATE %s %s%s AS\n%s\n", keyword, qualified, with, strings.TrimRight(strings.TrimSpace(body), ";")+";")
	default:
		if err := writeTableDDL(ctx, tx, &b, oid, qualified, kind == "p", with); err != nil {
			return "", err
		}
	}

	if kind != "v" {
		if err := writeIndexDDL(ctx, tx, &b, oid); err != nil {
			return "", err
		}
	}
	return b.String(), nil
}

func writeTableDDL(ctx context.Context, tx pgx.Tx, b *strings.Builder, oid uint32, qualified string, partitioned bool, with string) error {
	rows, err := tx.Query(ctx,
		`SELECT format('%I', a.attname), format_type(a.atttypid, a.atttypmod), a.attnotnull,
			a.attidentity::text, a.attgenerated::text, pg_get_expr(d.adbin, d.adrelid),
			CASE WHEN a.attcollation <> 0 AND a.attcollation <> t.typcollation
				THEN format('%I.%I', cn.nspname, co.collname) END,
			seq.name, seq.typ, seq.seqstart, seq.seqincrement, seq.seqmin, seq.seqmax, seq.seqcache, seq.seqcycle
		FROM pg_attribute a
		JOIN pg_type t ON t.oid = a.atttypid
		LEFT JOIN pg_collation co ON co.oid = a.attcollation
		LEFT JOIN pg_namespace cn ON cn.oid = co.collnamespace
		LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
		-- The sequence behind an identity (deptype i) or serial (deptype a) column.
		LEFT JOIN LATERAL (
			SELECT format('%I.%I', sn.nspname, sc.relname) AS name, format_type(s.seqtypid, NULL) AS typ,
				s.seqstart, s.seqincrement, s.seqmin, s.seqmax, s.seqcache, s.seqcycle
			FROM pg_depend dep
			JOIN pg_class sc ON sc.oid = dep.objid AND sc.relkind = 'S'
			JOIN pg_namespace sn ON sn.oid = sc.relnamespace
			JOIN pg_sequence s ON s.seqrelid = sc.oid
			WHERE dep.classid = 'pg_class'::regclass AND dep.refclassid = 'pg_class'::regclass
			  AND dep.refobjid = a.attrelid AND dep.refobjsubid = a.attnum AND dep.deptype IN ('a', 'i')
			LIMIT 1
		) seq ON TRUE
		WHERE a.attrelid = $1 AND a.attnum > 0 AND NOT a.attisdropped
		ORDER BY a.attnum`,
		oid,
	)
	if err != nil {
		return normalizePostgresError(fmt.Errorf("failed to read columns: %w", err))
	}
	type column struct {
		name, rest string
	}
	var columns []column
	var sequenceFixups []string
	width := 0
	for rows.Next() {
		var (
			name, typ           string
			notNull             bool
			identity, generated string
			expr, collation     *string
			seqName, seqType    *string
			seq                 sequenceParams
		)
		if err := rows.Scan(&name, &typ, &notNull, &identity, &generated, &expr, &collation,
			&seqName, &seqType, &seq.start, &seq.increment, &seq.min, &seq.max, &seq.cache, &seq.cycle); err != nil {
			rows.Close()
			return normalizePostgresError(fmt.Errorf("failed to read columns: %w", err))
		}
		// A serial column's sequence is not printed, so its nextval() default
		// would not replay; the serial pseudo-type recreates both.
		serial := map[string]string{"smallint": "smallserial", "integer": "serial", "bigint": "bigserial"}[typ]
		seqOptions := ""
		if seqName != nil && seqType != nil {
			seqOptions = seq.nonDefault(*seqType)
		}
		rest := typ
		if collation != nil {
			rest += " COLLATE " + *collation
		}
		switch {
		case seqName != nil && identity == "" && serial != "" && expr != nil && strings.HasPrefix(*expr, "nextval("):
			rest = serial
			// serial has no clause for sequence options, so they follow the
			// table; RESTART makes a changed START WITH take effect at once.
			if seqOptions != "" {
				fixup := "ALTER SEQUENCE " + *seqName + " " + seqOptions
				if strings.HasPrefix(seqOptions, "START WITH") {
					fixup += " RESTART"
				}
				sequenceFixups = append(sequenceFixups, fixup+";")
			}
		case identity == "a" || identity == "d":
			rest += map[string]string{"a": " GENERATED ALWAYS AS IDENTITY", "d": " GENERATED BY DEFAULT AS IDENTITY"}[identity]
			if seqOptions != "" {
				rest += " (" + seqOptions + ")"
			}
		case generated == "s" && expr != nil:
			rest += " GENERATED ALWAYS AS (" + *expr + ") STORED"
		case generated == "v" && expr != nil:
			rest += " GENERATED ALWAYS AS (" + *expr + ") VIRTUAL"
		case expr != nil:
			rest += " DEFAULT " + *expr
		}
		if notNull {
			rest += " NOT NULL"
		}
		columns = append(columns, column{name, rest})
		width = max(width, len(name))
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return normalizePostgresError(fmt.Errorf("failed to read columns: %w", err))
	}

	// NOT NULL is already on its column ('n' rows exist from Postgres 18 on).
	rows, err = tx.Query(ctx,
		`SELECT format('%I', conname), pg_get_constraintdef(oid, true)
		FROM pg_constraint
		WHERE conrelid = $1 AND contype IN ('p', 'u', 'f', 'c', 'x')
		ORDER BY CASE contype WHEN 'p' THEN 0 WHEN 'u' THEN 1 WHEN 'f' THEN 2 WHEN 'c' THEN 3 ELSE 4 END, conname`,
		oid,
	)
	if err != nil {
		return normalizePostgresError(fmt.Errorf("failed to read constraints: %w", err))
	}
	var constraints []string
	for rows.Next() {
		var name, def string
		if err := rows.Scan(&name, &def); err != nil {
			rows.Close()
			return normalizePostgresError(fmt.Errorf("failed to read constraints: %w", err))
		}
		constraints = append(constraints, "CONSTRAINT "+name+" "+def)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return normalizePostgresError(fmt.Errorf("failed to read constraints: %w", err))
	}

	lines := make([]string, 0, len(columns)+len(constraints))
	for _, c := range columns {
		lines = append(lines, fmt.Sprintf("%-*s %s", width, c.name, c.rest))
	}
	lines = append(lines, constraints...)
	fmt.Fprintf(b, "CREATE TABLE %s (\n    %s\n)", qualified, strings.Join(lines, ",\n    "))

	if partitioned {
		var key string
		if err := tx.QueryRow(ctx, `SELECT pg_get_partkeydef($1::oid)`, oid).Scan(&key); err != nil {
			return normalizePostgresError(fmt.Errorf("failed to read partition key: %w", err))
		}
		b.WriteString(" PARTITION BY " + key)
	}
	b.WriteString(with + ";\n")
	for _, fixup := range sequenceFixups {
		b.WriteString(fixup + "\n")
	}
	return nil
}

type sequenceParams struct {
	start, increment, min, max, cache *int64
	cycle                             *bool
}

// nonDefault spells out the sequence options that differ from what CREATE
// SEQUENCE ... AS typ would pick by itself, so a plain identity column stays
// a plain "AS IDENTITY" and a customised one keeps its START WITH 100.
func (s sequenceParams) nonDefault(typ string) string {
	if s.start == nil || s.increment == nil || s.min == nil || s.max == nil || s.cache == nil || s.cycle == nil {
		return ""
	}
	typMax := map[string]int64{"smallint": math.MaxInt16, "integer": math.MaxInt32}[typ]
	if typMax == 0 {
		typMax = math.MaxInt64
	}
	defMin, defMax, defStart := int64(1), typMax, *s.min
	if *s.increment < 0 {
		defMin, defMax, defStart = -typMax-1, -1, *s.max
	}

	var parts []string
	if *s.start != defStart {
		parts = append(parts, fmt.Sprintf("START WITH %d", *s.start))
	}
	if *s.increment != 1 {
		parts = append(parts, fmt.Sprintf("INCREMENT BY %d", *s.increment))
	}
	if *s.min != defMin {
		parts = append(parts, fmt.Sprintf("MINVALUE %d", *s.min))
	}
	if *s.max != defMax {
		parts = append(parts, fmt.Sprintf("MAXVALUE %d", *s.max))
	}
	if *s.cache != 1 {
		parts = append(parts, fmt.Sprintf("CACHE %d", *s.cache))
	}
	if *s.cycle {
		parts = append(parts, "CYCLE")
	}
	return strings.Join(parts, " ")
}

// writeIndexDDL appends indexes that are not already spelled out as a
// PRIMARY KEY / UNIQUE / EXCLUDE constraint above.
func writeIndexDDL(ctx context.Context, tx pgx.Tx, b *strings.Builder, oid uint32) error {
	rows, err := tx.Query(ctx,
		`SELECT pg_get_indexdef(i.indexrelid)
		FROM pg_index i
		JOIN pg_class ic ON ic.oid = i.indexrelid
		WHERE i.indrelid = $1
		  AND NOT EXISTS (
			SELECT 1 FROM pg_constraint c
			WHERE c.conrelid = i.indrelid AND c.conindid = i.indexrelid AND c.contype IN ('p', 'u', 'x')
		  )
		ORDER BY ic.relname`,
		oid,
	)
	if err != nil {
		return normalizePostgresError(fmt.Errorf("failed to read indexes: %w", err))
	}
	defer rows.Close()

	first := true
	for rows.Next() {
		var def string
		if err := rows.Scan(&def); err != nil {
			return normalizePostgresError(fmt.Errorf("failed to read indexes: %w", err))
		}
		if first {
			b.WriteString("\n")
			first = false
		}
		b.WriteString(def + ";\n")
	}
	return normalizePostgresError(rows.Err())
}
