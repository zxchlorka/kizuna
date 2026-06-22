package postgres

import (
	"context"
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/qsnake66/infraview/internal/connector"
)

var (
	leadingCommentRE   = regexp.MustCompile(`(?s)\A(?:\s+|--.*?\n|/\*.*?\*/)*`)
	returningClauseRE  = regexp.MustCompile(`(?i)\breturning\b`)
	schemaChangeStmtRE = regexp.MustCompile(`(?i)\A(?:\s+|--.*?\n|/\*.*?\*/)*(create|alter|drop|truncate|reindex|comment)\b`)
	postgresTypeMap    = pgtype.NewMap()
)

const (
	defaultQueryRowLimit = 500
	hardQueryRowLimit    = 500
)

type rowFetchPolicy struct {
	readLimit    int
	appliedLimit int
}

func (p *PostgresConnector) Execute(ctx context.Context, command string) (*connector.ExecResult, error) {
	return p.executeWithExecutor(ctx, p.pool, command)
}

func (p *PostgresConnector) ExecuteBatch(ctx context.Context, commands []string) ([]connector.ExecResult, error) {
	if len(commands) == 0 {
		return nil, fmt.Errorf("%w: statements are required", connector.ErrBadRequest)
	}

	session, err := p.pool.Acquire(ctx)
	if err != nil {
		return nil, normalizePostgresError(err)
	}
	defer session.Release()

	results := make([]connector.ExecResult, 0, len(commands))
	for idx, command := range commands {
		trimmed := strings.TrimSpace(command)
		if trimmed == "" {
			results = append(results, connector.ExecResult{
				Statement: command,
				Error:     "statement is empty",
			})
			for _, skipped := range commands[idx+1:] {
				results = append(results, connector.ExecResult{Statement: skipped, Skipped: true})
			}
			break
		}

		startedAt := time.Now()
		result, execErr := p.executeWithExecutor(ctx, session, command)
		if execErr != nil {
			results = append(results, connector.ExecResult{
				Statement:  command,
				Error:      execErr.Error(),
				DurationMs: time.Since(startedAt).Milliseconds(),
			})
			for _, skipped := range commands[idx+1:] {
				results = append(results, connector.ExecResult{Statement: skipped, Skipped: true})
			}
			break
		}
		results = append(results, *result)
	}

	return results, nil
}

func (p *PostgresConnector) executeWithExecutor(ctx context.Context, exec sqlExecutor, command string) (*connector.ExecResult, error) {
	statement := strings.TrimSpace(command)
	if statement == "" {
		return nil, fmt.Errorf("%w: statement is required", connector.ErrBadRequest)
	}

	startedAt := time.Now()
	if isRowReturningStatement(statement) {
		result, err := p.executeQuery(ctx, exec, statement)
		if err != nil {
			return nil, err
		}
		result.Statement = command
		result.DurationMs = time.Since(startedAt).Milliseconds()
		if isSchemaChangingStatement(statement) {
			p.invalidateCompletionCache()
		}
		return result, nil
	}

	tag, err := exec.Exec(ctx, statement)
	if err != nil {
		return nil, normalizePostgresError(err)
	}
	if isSchemaChangingStatement(statement) {
		p.invalidateCompletionCache()
	}

	return &connector.ExecResult{
		Statement:    command,
		RowsAffected: tag.RowsAffected(),
		DurationMs:   time.Since(startedAt).Milliseconds(),
	}, nil
}

func (p *PostgresConnector) executeQuery(ctx context.Context, exec sqlExecutor, statement string) (*connector.ExecResult, error) {
	policy, err := rowFetchPolicyForStatement(statement)
	if err != nil {
		return nil, err
	}

	rows, err := exec.Query(ctx, statement)
	if err != nil {
		return nil, normalizePostgresError(err)
	}
	defer rows.Close()

	fields := rows.FieldDescriptions()
	columns := make([]string, 0, len(fields))
	for _, field := range fields {
		columns = append(columns, field.Name)
	}
	columnTypes := columnTypeNames(fields)

	resultRows := make([][]any, 0, minInt(policy.readLimit, 128))
	for rows.Next() {
		values, valuesErr := rows.Values()
		if valuesErr != nil {
			return nil, normalizePostgresError(valuesErr)
		}
		row := make([]any, len(values))
		copy(row, values)
		resultRows = append(resultRows, row)
		if len(resultRows) >= policy.readLimit {
			break
		}
	}
	if err := rows.Err(); err != nil {
		return nil, normalizePostgresError(err)
	}

	truncated := false
	if policy.appliedLimit > 0 && len(resultRows) > policy.appliedLimit {
		truncated = true
		resultRows = resultRows[:policy.appliedLimit]
	}

	return &connector.ExecResult{
		Columns:       columns,
		ColumnTypes:   columnTypes,
		Rows:          resultRows,
		RowsReturned:  len(resultRows),
		RowsAffected:  rows.CommandTag().RowsAffected(),
		Truncated:     truncated,
		AppliedLimit:  policy.appliedLimit,
		ColumnSources: resolveColumnSources(ctx, exec, fields),
	}, nil
}

type oidAttn struct {
	oid    uint32
	attnum uint16
}

// buildColumnSources aligns resolved table/column provenance to the result
// fields. Fields with TableOID == 0 (expressions/aggregates) or with no catalog
// match get a nil entry. Returns nil if no field has provenance.
func buildColumnSources(fields []pgconn.FieldDescription, lookup map[oidAttn]connector.ColumnSource) []*connector.ColumnSource {
	if len(fields) == 0 {
		return nil
	}
	out := make([]*connector.ColumnSource, len(fields))
	found := false
	for i, field := range fields {
		if field.TableOID == 0 {
			continue
		}
		if src, ok := lookup[oidAttn{oid: field.TableOID, attnum: field.TableAttributeNumber}]; ok {
			copied := src
			out[i] = &copied
			found = true
		}
	}
	if !found {
		return nil
	}
	return out
}

// resolveColumnSources resolves result-column provenance via one catalog query.
// Best-effort: any error returns nil so the query result is still served.
func resolveColumnSources(ctx context.Context, exec sqlExecutor, fields []pgconn.FieldDescription) []*connector.ColumnSource {
	seen := make(map[oidAttn]bool)
	pairs := make([]oidAttn, 0, len(fields))
	for _, field := range fields {
		if field.TableOID == 0 {
			continue
		}
		key := oidAttn{oid: field.TableOID, attnum: field.TableAttributeNumber}
		if !seen[key] {
			seen[key] = true
			pairs = append(pairs, key)
		}
	}
	if len(pairs) == 0 {
		return nil
	}

	placeholders := make([]string, 0, len(pairs))
	args := make([]any, 0, len(pairs)*2)
	for i, pair := range pairs {
		// Cast explicitly: oid is sent as int8 (pgx has no uint32 codec) and PG
		// coerces it back to oid/int2 for the row-value comparison.
		placeholders = append(placeholders, fmt.Sprintf("($%d::oid, $%d::int2)", i*2+1, i*2+2))
		args = append(args, int64(pair.oid), int16(pair.attnum))
	}
	query := fmt.Sprintf(`SELECT c.oid, a.attnum, n.nspname, c.relname, a.attname
FROM pg_attribute a
JOIN pg_class c ON a.attrelid = c.oid
JOIN pg_namespace n ON c.relnamespace = n.oid
WHERE a.attnum > 0 AND (c.oid, a.attnum) IN (%s)`, strings.Join(placeholders, ","))

	rows, err := exec.Query(ctx, query, args...)
	if err != nil {
		return nil
	}
	defer rows.Close()

	lookup := make(map[oidAttn]connector.ColumnSource, len(pairs))
	for rows.Next() {
		var oid uint32
		var attnum int16
		var schema, table, column string
		if scanErr := rows.Scan(&oid, &attnum, &schema, &table, &column); scanErr != nil {
			return nil
		}
		lookup[oidAttn{oid: oid, attnum: uint16(attnum)}] = connector.ColumnSource{Table: schema + "." + table, Column: column}
	}
	if rows.Err() != nil {
		return nil
	}
	return buildColumnSources(fields, lookup)
}

func columnTypeNames(fields []pgconn.FieldDescription) []string {
	out := make([]string, 0, len(fields))
	for _, field := range fields {
		typeName := "unknown"
		if dataType, ok := postgresTypeMap.TypeForOID(field.DataTypeOID); ok && dataType != nil && dataType.Name != "" {
			typeName = dataType.Name
		}
		out = append(out, typeName)
	}
	return out
}

func isRowReturningStatement(statement string) bool {
	trimmed := strings.ToLower(leadingCommentRE.ReplaceAllString(statement, ""))
	switch {
	case strings.HasPrefix(trimmed, "select "),
		strings.HasPrefix(trimmed, "select\n"),
		strings.HasPrefix(trimmed, "values "),
		strings.HasPrefix(trimmed, "values\n"),
		strings.HasPrefix(trimmed, "show "),
		strings.HasPrefix(trimmed, "show\n"),
		strings.HasPrefix(trimmed, "with "),
		strings.HasPrefix(trimmed, "with\n"):
		return true
	default:
		return returningClauseRE.MatchString(trimmed)
	}
}

func isSchemaChangingStatement(statement string) bool {
	return schemaChangeStmtRE.MatchString(statement)
}

func quotedTableRef(schema string, table string) string {
	return pgx.Identifier{schema, table}.Sanitize()
}

func rowFetchPolicyForStatement(statement string) (rowFetchPolicy, error) {
	limitInfo, err := topLevelLimit(statement)
	if err != nil {
		return rowFetchPolicy{}, fmt.Errorf("%w: %v", connector.ErrBadRequest, err)
	}

	if !limitInfo.found {
		return rowFetchPolicy{
			readLimit:    defaultQueryRowLimit + 1,
			appliedLimit: defaultQueryRowLimit,
		}, nil
	}

	if limitInfo.isAll || !limitInfo.literal {
		return rowFetchPolicy{}, fmt.Errorf("%w: row-returning queries must use a literal LIMIT <= %d", connector.ErrBadRequest, hardQueryRowLimit)
	}

	if limitInfo.value < 0 || limitInfo.value > hardQueryRowLimit {
		return rowFetchPolicy{}, fmt.Errorf("%w: LIMIT %d exceeds maximum %d rows for SQL Console", connector.ErrBadRequest, limitInfo.value, hardQueryRowLimit)
	}

	return rowFetchPolicy{readLimit: limitInfo.value}, nil
}

type limitInfo struct {
	found   bool
	literal bool
	isAll   bool
	value   int
}

func topLevelLimit(statement string) (limitInfo, error) {
	depth := 0
	for i := 0; i < len(statement); {
		next, err := skipSQLTrivia(statement, i)
		if err != nil {
			return limitInfo{}, err
		}
		i = next
		if i >= len(statement) {
			break
		}

		if end, ok, err := skipSQLQuoted(statement, i); err != nil {
			return limitInfo{}, err
		} else if ok {
			i = end
			continue
		}

		switch statement[i] {
		case '(':
			depth++
			i++
			continue
		case ')':
			if depth > 0 {
				depth--
			}
			i++
			continue
		}

		if depth == 0 && isSQLIdentStart(statement[i]) {
			token, end := readSQLIdentifier(statement, i)
			if strings.EqualFold(token, "limit") {
				info, err := readLimitValue(statement, end)
				if err != nil {
					return limitInfo{}, err
				}
				info.found = true
				return info, nil
			}
			i = end
			continue
		}

		i++
	}

	return limitInfo{}, nil
}

func readLimitValue(statement string, start int) (limitInfo, error) {
	i, err := skipSQLTrivia(statement, start)
	if err != nil {
		return limitInfo{}, err
	}
	if i >= len(statement) {
		return limitInfo{}, fmt.Errorf("LIMIT clause is incomplete")
	}

	if end, ok, err := skipSQLQuoted(statement, i); err != nil {
		return limitInfo{}, err
	} else if ok {
		return limitInfo{literal: false, value: 0}, fmt.Errorf("LIMIT must use an integer literal, found quoted token ending at %d", end)
	}

	if isSQLIdentStart(statement[i]) {
		token, _ := readSQLIdentifier(statement, i)
		if strings.EqualFold(token, "all") {
			return limitInfo{literal: true, isAll: true}, nil
		}
		return limitInfo{literal: false}, nil
	}

	if statement[i] == '+' || statement[i] == '-' || isSQLDigit(statement[i]) {
		sign := 1
		if statement[i] == '+' {
			i++
		} else if statement[i] == '-' {
			sign = -1
			i++
		}
		if i >= len(statement) || !isSQLDigit(statement[i]) {
			return limitInfo{literal: false}, nil
		}
		literal, end := readSQLDigits(statement, i)
		parsed, err := strconv.Atoi(literal)
		if err != nil {
			return limitInfo{}, fmt.Errorf("invalid LIMIT literal %q: %w", literal, err)
		}
		if end < len(statement) && statement[end] == '.' {
			return limitInfo{literal: false}, nil
		}
		if sign < 0 {
			parsed *= -1
		}
		return limitInfo{literal: true, value: parsed}, nil
	}

	return limitInfo{literal: false}, nil
}

func skipSQLTrivia(statement string, start int) (int, error) {
	for i := start; i < len(statement); {
		switch {
		case isSQLSpace(statement[i]):
			i++
		case strings.HasPrefix(statement[i:], "--"):
			i += 2
			for i < len(statement) && statement[i] != '\n' {
				i++
			}
		case strings.HasPrefix(statement[i:], "/*"):
			end := strings.Index(statement[i+2:], "*/")
			if end < 0 {
				return 0, fmt.Errorf("unterminated block comment")
			}
			i += end + 4
		default:
			return i, nil
		}
	}
	return len(statement), nil
}

func skipSQLQuoted(statement string, start int) (int, bool, error) {
	if start >= len(statement) {
		return start, false, nil
	}

	switch statement[start] {
	case '\'':
		i := start + 1
		for i < len(statement) {
			if statement[i] == '\'' {
				if i+1 < len(statement) && statement[i+1] == '\'' {
					i += 2
					continue
				}
				return i + 1, true, nil
			}
			i++
		}
		return 0, false, fmt.Errorf("unterminated string literal")
	case '"':
		i := start + 1
		for i < len(statement) {
			if statement[i] == '"' {
				if i+1 < len(statement) && statement[i+1] == '"' {
					i += 2
					continue
				}
				return i + 1, true, nil
			}
			i++
		}
		return 0, false, fmt.Errorf("unterminated quoted identifier")
	case '$':
		delimiter, ok := readDollarQuoteDelimiter(statement, start)
		if !ok {
			return start, false, nil
		}
		end := strings.Index(statement[start+len(delimiter):], delimiter)
		if end < 0 {
			return 0, false, fmt.Errorf("unterminated dollar-quoted string")
		}
		return start + len(delimiter) + end + len(delimiter), true, nil
	default:
		return start, false, nil
	}
}

func readDollarQuoteDelimiter(statement string, start int) (string, bool) {
	if start >= len(statement) || statement[start] != '$' {
		return "", false
	}
	i := start + 1
	for i < len(statement) && statement[i] != '$' {
		if !isSQLIdentPart(statement[i]) {
			return "", false
		}
		i++
	}
	if i >= len(statement) || statement[i] != '$' {
		return "", false
	}
	return statement[start : i+1], true
}

func readSQLIdentifier(statement string, start int) (string, int) {
	end := start + 1
	for end < len(statement) && isSQLIdentPart(statement[end]) {
		end++
	}
	return statement[start:end], end
}

func readSQLDigits(statement string, start int) (string, int) {
	end := start
	for end < len(statement) && isSQLDigit(statement[end]) {
		end++
	}
	return statement[start:end], end
}

func isSQLIdentStart(ch byte) bool {
	return (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || ch == '_'
}

func isSQLIdentPart(ch byte) bool {
	return isSQLIdentStart(ch) || isSQLDigit(ch) || ch == '$'
}

func isSQLDigit(ch byte) bool {
	return ch >= '0' && ch <= '9'
}

func isSQLSpace(ch byte) bool {
	switch ch {
	case ' ', '\t', '\n', '\r', '\f':
		return true
	default:
		return false
	}
}

func minInt(left int, right int) int {
	if left < right {
		return left
	}
	return right
}
