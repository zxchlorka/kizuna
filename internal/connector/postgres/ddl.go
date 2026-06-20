package postgres

import (
	"context"
	"encoding/json"
	"fmt"
	"regexp"
	"strconv"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/qsnake66/infraview/internal/connector"
)

var (
	varcharTypePattern = regexp.MustCompile(`^(?:varchar|character varying)\((\d+)\)$`)
	decimalTypePattern = regexp.MustCompile(`^(?:decimal|numeric)\((\d+)\s*,\s*(\d+)\)$`)
	numericLiteral     = regexp.MustCompile(`^-?\d+(?:\.\d+)?$`)
)

type ddlCreateTableParams struct {
	Columns []ddlColumnInput `json:"columns"`
}

type ddlAddColumnParams struct {
	Name     string `json:"name"`
	Type     string `json:"type"`
	Nullable bool   `json:"nullable"`
	Default  any    `json:"default"`
}

type ddlDropColumnParams struct {
	Name string `json:"name"`
}

type ddlCreateIndexParams struct {
	Name    string   `json:"name"`
	Columns []string `json:"columns"`
	Unique  bool     `json:"unique"`
}

type ddlColumnInput struct {
	Name       string `json:"name"`
	Type       string `json:"type"`
	Nullable   bool   `json:"nullable"`
	PrimaryKey bool   `json:"primary_key"`
	Default    any    `json:"default"`
}

func (p *PostgresConnector) DDL(ctx context.Context, op connector.DDLOp) error {
	if op.Type == "" || op.Schema == "" || op.Object == "" {
		return fmt.Errorf("%w: type, schema, and object are required", connector.ErrBadRequest)
	}

	statement, err := buildDDLStatement(op)
	if err != nil {
		return err
	}

	if _, err := p.pool.Exec(ctx, statement); err != nil {
		return normalizePostgresError(err)
	}
	p.invalidateObjectCache()
	p.invalidateSchemaCache()
	p.invalidateCompletionCache()
	return nil
}

func buildDDLStatement(op connector.DDLOp) (string, error) {
	switch op.Type {
	case "create_table":
		return buildCreateTableSQL(op)
	case "drop_table":
		return fmt.Sprintf("DROP TABLE %s", pgx.Identifier{op.Schema, op.Object}.Sanitize()), nil
	case "add_column":
		return buildAddColumnSQL(op)
	case "drop_column":
		return buildDropColumnSQL(op)
	case "create_index":
		return buildCreateIndexSQL(op)
	case "drop_index":
		return fmt.Sprintf("DROP INDEX %s", pgx.Identifier{op.Schema, op.Object}.Sanitize()), nil
	default:
		return "", fmt.Errorf("%w: unsupported ddl type %q", connector.ErrBadRequest, op.Type)
	}
}

func buildCreateTableSQL(op connector.DDLOp) (string, error) {
	var params ddlCreateTableParams
	if err := decodeDDLParams(op.Params, &params); err != nil {
		return "", err
	}
	if len(params.Columns) == 0 {
		return "", fmt.Errorf("%w: create_table requires at least one column", connector.ErrBadRequest)
	}

	definitions := make([]string, 0, len(params.Columns)+1)
	pkColumns := make([]string, 0, len(params.Columns))
	seen := make(map[string]struct{}, len(params.Columns))

	for _, column := range params.Columns {
		if column.Name == "" {
			return "", fmt.Errorf("%w: column name is required", connector.ErrBadRequest)
		}
		if _, ok := seen[column.Name]; ok {
			return "", fmt.Errorf("%w: duplicate column %q", connector.ErrBadRequest, column.Name)
		}
		seen[column.Name] = struct{}{}

		typeSQL, err := sanitizeDDLType(column.Type)
		if err != nil {
			return "", err
		}

		definition := []string{pgx.Identifier{column.Name}.Sanitize(), typeSQL}
		if !column.Nullable || column.PrimaryKey {
			definition = append(definition, "NOT NULL")
		}

		defaultSQL, err := buildDefaultExpression(column.Default, typeSQL)
		if err != nil {
			return "", err
		}
		if defaultSQL != "" {
			definition = append(definition, "DEFAULT", defaultSQL)
		}

		definitions = append(definitions, strings.Join(definition, " "))
		if column.PrimaryKey {
			pkColumns = append(pkColumns, pgx.Identifier{column.Name}.Sanitize())
		}
	}

	if len(pkColumns) > 0 {
		definitions = append(definitions, fmt.Sprintf("PRIMARY KEY (%s)", strings.Join(pkColumns, ", ")))
	}

	return fmt.Sprintf(
		"CREATE TABLE %s (%s)",
		pgx.Identifier{op.Schema, op.Object}.Sanitize(),
		strings.Join(definitions, ", "),
	), nil
}

func buildAddColumnSQL(op connector.DDLOp) (string, error) {
	var params ddlAddColumnParams
	if err := decodeDDLParams(op.Params, &params); err != nil {
		return "", err
	}
	if params.Name == "" {
		return "", fmt.Errorf("%w: add_column requires name", connector.ErrBadRequest)
	}

	typeSQL, err := sanitizeDDLType(params.Type)
	if err != nil {
		return "", err
	}

	parts := []string{
		"ALTER TABLE",
		pgx.Identifier{op.Schema, op.Object}.Sanitize(),
		"ADD COLUMN",
		pgx.Identifier{params.Name}.Sanitize(),
		typeSQL,
	}
	if !params.Nullable {
		parts = append(parts, "NOT NULL")
	}

	defaultSQL, err := buildDefaultExpression(params.Default, typeSQL)
	if err != nil {
		return "", err
	}
	if defaultSQL != "" {
		parts = append(parts, "DEFAULT", defaultSQL)
	}

	return strings.Join(parts, " "), nil
}

func buildDropColumnSQL(op connector.DDLOp) (string, error) {
	var params ddlDropColumnParams
	if err := decodeDDLParams(op.Params, &params); err != nil {
		return "", err
	}
	if params.Name == "" {
		return "", fmt.Errorf("%w: drop_column requires name", connector.ErrBadRequest)
	}

	return fmt.Sprintf(
		"ALTER TABLE %s DROP COLUMN %s",
		pgx.Identifier{op.Schema, op.Object}.Sanitize(),
		pgx.Identifier{params.Name}.Sanitize(),
	), nil
}

func buildCreateIndexSQL(op connector.DDLOp) (string, error) {
	var params ddlCreateIndexParams
	if err := decodeDDLParams(op.Params, &params); err != nil {
		return "", err
	}
	if params.Name == "" {
		return "", fmt.Errorf("%w: create_index requires name", connector.ErrBadRequest)
	}
	if len(params.Columns) == 0 {
		return "", fmt.Errorf("%w: create_index requires columns", connector.ErrBadRequest)
	}

	columnRefs := make([]string, 0, len(params.Columns))
	for _, column := range params.Columns {
		if strings.TrimSpace(column) == "" {
			return "", fmt.Errorf("%w: create_index columns must be non-empty", connector.ErrBadRequest)
		}
		columnRefs = append(columnRefs, pgx.Identifier{column}.Sanitize())
	}

	prefix := "CREATE INDEX"
	if params.Unique {
		prefix = "CREATE UNIQUE INDEX"
	}

	return fmt.Sprintf(
		"%s %s ON %s (%s)",
		prefix,
		pgx.Identifier{params.Name}.Sanitize(),
		pgx.Identifier{op.Schema, op.Object}.Sanitize(),
		strings.Join(columnRefs, ", "),
	), nil
}

func decodeDDLParams(raw map[string]any, dest any) error {
	if len(raw) == 0 {
		return fmt.Errorf("%w: params are required", connector.ErrBadRequest)
	}

	data, err := json.Marshal(raw)
	if err != nil {
		return fmt.Errorf("%w: invalid params", connector.ErrBadRequest)
	}
	if err := json.Unmarshal(data, dest); err != nil {
		return fmt.Errorf("%w: invalid params: %s", connector.ErrBadRequest, err.Error())
	}
	return nil
}

func sanitizeDDLType(raw string) (string, error) {
	value := strings.ToLower(strings.TrimSpace(raw))
	switch value {
	case "integer", "bigint", "text", "boolean", "timestamp", "timestamptz", "uuid", "jsonb":
		return value, nil
	}

	if matches := varcharTypePattern.FindStringSubmatch(value); matches != nil {
		size, _ := strconv.Atoi(matches[1])
		if size <= 0 {
			return "", fmt.Errorf("%w: varchar size must be positive", connector.ErrBadRequest)
		}
		return fmt.Sprintf("varchar(%d)", size), nil
	}

	if matches := decimalTypePattern.FindStringSubmatch(value); matches != nil {
		precision, _ := strconv.Atoi(matches[1])
		scale, _ := strconv.Atoi(matches[2])
		if precision <= 0 || scale < 0 || scale > precision {
			return "", fmt.Errorf("%w: invalid decimal precision/scale", connector.ErrBadRequest)
		}
		return fmt.Sprintf("decimal(%d,%d)", precision, scale), nil
	}

	return "", fmt.Errorf("%w: unsupported ddl type %q", connector.ErrBadRequest, raw)
}

func buildDefaultExpression(raw any, dataType string) (string, error) {
	if raw == nil {
		return "", nil
	}

	switch value := raw.(type) {
	case string:
		trimmed := strings.TrimSpace(value)
		if trimmed == "" {
			return "", nil
		}
		return buildStringDefault(trimmed, dataType)
	case bool:
		if value {
			return "TRUE", nil
		}
		return "FALSE", nil
	case float64:
		return strconv.FormatFloat(value, 'f', -1, 64), nil
	case int:
		return strconv.Itoa(value), nil
	case int64:
		return strconv.FormatInt(value, 10), nil
	default:
		if strings.HasPrefix(dataType, "jsonb") {
			payload, err := json.Marshal(raw)
			if err != nil {
				return "", fmt.Errorf("%w: invalid jsonb default", connector.ErrBadRequest)
			}
			return fmt.Sprintf("'%s'::jsonb", escapeSQLLiteral(string(payload))), nil
		}
		return "", fmt.Errorf("%w: unsupported default value", connector.ErrBadRequest)
	}
}

func buildStringDefault(raw string, dataType string) (string, error) {
	upper := strings.ToUpper(raw)
	switch {
	case upper == "CURRENT_TIMESTAMP":
		if dataType == "timestamp" || dataType == "timestamptz" {
			return upper, nil
		}
	case raw == "now()":
		if dataType == "timestamp" || dataType == "timestamptz" {
			return raw, nil
		}
	case raw == "gen_random_uuid()" || raw == "uuid_generate_v4()":
		if dataType == "uuid" {
			return raw, nil
		}
	case strings.EqualFold(raw, "true") || strings.EqualFold(raw, "false"):
		if dataType == "boolean" {
			return strings.ToUpper(raw), nil
		}
	case numericLiteral.MatchString(raw):
		if dataType == "integer" || dataType == "bigint" || strings.HasPrefix(dataType, "decimal(") {
			return raw, nil
		}
	}

	switch {
	case dataType == "jsonb":
		return fmt.Sprintf("'%s'::jsonb", escapeSQLLiteral(raw)), nil
	default:
		return fmt.Sprintf("'%s'", escapeSQLLiteral(raw)), nil
	}
}

func escapeSQLLiteral(value string) string {
	return strings.ReplaceAll(value, "'", "''")
}
