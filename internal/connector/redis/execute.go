package redis

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/qsnake66/kizuna/internal/connector"
	goredis "github.com/redis/go-redis/v9"
)

const (
	maxCommandCompletions = 50
	maxExecResultRows     = 1000
	executeTimeout        = 15 * time.Second
)

// Commands that hijack the connection (streaming or pub/sub) cannot work over the
// request/response CLI and would leave the pooled connection unusable.
var blockedRedisCommands = map[string]struct{}{
	"MONITOR":    {},
	"SUBSCRIBE":  {},
	"PSUBSCRIBE": {},
	"SSUBSCRIBE": {},
}

func rejectBlockedRedisCommand(args []string) error {
	if len(args) == 0 {
		return nil
	}
	name := strings.ToUpper(args[0])
	if _, ok := blockedRedisCommands[name]; ok {
		return fmt.Errorf("%w: %s is not supported in the CLI: it would hold the connection open. Use a dedicated redis-cli session instead", connector.ErrBadRequest, name)
	}
	return nil
}

// rejectReadOnlyRedisCommand blocks any command that is not on the read-only
// allowlist when the connection is read-only (fail-closed).
func (c *RedisConnector) rejectReadOnlyRedisCommand(args []string) error {
	if !c.config.ReadOnly || len(args) == 0 {
		return nil
	}
	if !isRedisReadOnlyCommand(args[0]) {
		return fmt.Errorf("%w: %s is blocked on a read-only connection", connector.ErrReadOnly, strings.ToUpper(args[0]))
	}
	return nil
}

func (c *RedisConnector) executeCommand(ctx context.Context, command string) (*connector.ExecResult, error) {
	args, err := parseRedisCommand(command)
	if err != nil {
		return nil, err
	}
	if err := rejectBlockedRedisCommand(args); err != nil {
		return nil, err
	}
	if err := c.rejectReadOnlyRedisCommand(args); err != nil {
		return nil, err
	}

	ctx, cancel := context.WithTimeout(ctx, executeTimeout)
	defer cancel()

	startedAt := time.Now()
	cmd := c.client.Do(ctx, anySlice(args)...)
	value, execErr := cmd.Result()
	result, err := c.formatExecResult(command, args, value, execErr, time.Since(startedAt))
	if err != nil {
		return nil, err
	}
	return result, nil
}

func (c *RedisConnector) executePipeline(ctx context.Context, commands []string) ([]connector.ExecResult, error) {
	parsedCommands := make([][]string, 0, len(commands))
	trimmedCommands := make([]string, 0, len(commands))
	for _, command := range commands {
		trimmed := strings.TrimSpace(command)
		if trimmed == "" {
			continue
		}
		args, err := parseRedisCommand(trimmed)
		if err != nil {
			return nil, err
		}
		if err := rejectBlockedRedisCommand(args); err != nil {
			return nil, err
		}
		if err := c.rejectReadOnlyRedisCommand(args); err != nil {
			return nil, err
		}
		parsedCommands = append(parsedCommands, args)
		trimmedCommands = append(trimmedCommands, trimmed)
	}
	if len(parsedCommands) == 0 {
		return nil, fmt.Errorf("%w: commands are required", connector.ErrBadRequest)
	}

	ctx, cancel := context.WithTimeout(ctx, executeTimeout)
	defer cancel()

	startedAt := time.Now()
	cmders, pipelineErr := c.client.Pipelined(ctx, func(pipe goredis.Pipeliner) error {
		for _, args := range parsedCommands {
			pipe.Do(ctx, anySlice(args)...)
		}
		return nil
	})
	totalDuration := time.Since(startedAt)
	if pipelineErr != nil && errors.Is(normalizeRedisError(pipelineErr), connector.ErrUnavailable) {
		return nil, normalizeRedisError(pipelineErr)
	}

	results := make([]connector.ExecResult, 0, len(parsedCommands))
	for index, command := range trimmedCommands {
		var (
			value   any
			cmdErr  error
			perCall = totalDuration / time.Duration(len(trimmedCommands))
		)
		if index < len(cmders) {
			value, cmdErr = cmders[index].(*goredis.Cmd).Result()
		} else {
			cmdErr = pipelineErr
		}
		formatted, err := c.formatExecResult(command, parsedCommands[index], value, cmdErr, perCall)
		if err != nil {
			return nil, err
		}
		results = append(results, *formatted)
	}

	return results, nil
}

func (c *RedisConnector) redisCompletions(ctx context.Context, req connector.CompletionRequest) ([]connector.CompletionItem, error) {
	switch req.Context {
	case "", "command":
		prefix := strings.ToUpper(strings.TrimSpace(req.Prefix))
		items := make([]connector.CompletionItem, 0, maxCommandCompletions)
		for _, name := range redisCommandNames {
			if prefix != "" && !strings.HasPrefix(name, prefix) {
				continue
			}
			command := redisCommandIndex[name]
			items = append(items, connector.CompletionItem{
				Label:  command.Name,
				Type:   "command",
				Detail: fmt.Sprintf("%s — %s", command.Syntax, command.Description),
			})
			if len(items) >= maxCommandCompletions {
				break
			}
		}
		return items, nil
	case "key":
		prefix := strings.TrimSpace(req.Prefix)
		pattern := prefix + "*"
		if prefix == "" {
			pattern = "*"
		}
		items := make([]connector.CompletionItem, 0, 20)
		err := c.scanMatchingKeys(ctx, pattern, func(key string) error {
			items = append(items, connector.CompletionItem{
				Label:  key,
				Type:   "key",
				Detail: "Redis key",
			})
			if len(items) >= 20 {
				return errRedisScanLimitReached
			}
			return nil
		})
		if err != nil && !errors.Is(err, errRedisScanLimitReached) {
			return nil, normalizeRedisError(err)
		}
		sort.Slice(items, func(i, j int) bool {
			return items[i].Label < items[j].Label
		})
		return items, nil
	default:
		return nil, fmt.Errorf("%w: completions context %q is not supported for redis", connector.ErrBadRequest, req.Context)
	}
}

func parseRedisCommand(command string) ([]string, error) {
	trimmed := strings.TrimSpace(command)
	if trimmed == "" {
		return nil, fmt.Errorf("%w: command is required", connector.ErrBadRequest)
	}

	var (
		tokens    []string
		current   strings.Builder
		inQuote   rune
		escaped   bool
		hasQuoted bool
	)

	flush := func(force bool) {
		if current.Len() == 0 && !force {
			return
		}
		tokens = append(tokens, current.String())
		current.Reset()
		hasQuoted = false
	}

	for _, r := range trimmed {
		switch {
		case escaped:
			current.WriteRune(r)
			escaped = false
		case r == '\\':
			escaped = true
		case inQuote != 0:
			if r == inQuote {
				inQuote = 0
				hasQuoted = true
				continue
			}
			current.WriteRune(r)
		case r == '"' || r == '\'':
			inQuote = r
		case r == ' ' || r == '\t' || r == '\n':
			if current.Len() > 0 || hasQuoted {
				flush(true)
			}
		default:
			current.WriteRune(r)
		}
	}

	if escaped {
		return nil, fmt.Errorf("%w: dangling escape in command", connector.ErrBadRequest)
	}
	if inQuote != 0 {
		return nil, fmt.Errorf("%w: unterminated quoted string", connector.ErrBadRequest)
	}
	if current.Len() > 0 || hasQuoted {
		flush(true)
	}
	if len(tokens) == 0 {
		return nil, fmt.Errorf("%w: command is required", connector.ErrBadRequest)
	}
	return tokens, nil
}

func (c *RedisConnector) formatExecResult(command string, args []string, value any, execErr error, duration time.Duration) (*connector.ExecResult, error) {
	result := &connector.ExecResult{
		Statement:  command,
		DurationMs: duration.Milliseconds(),
	}

	if execErr != nil {
		normalized := normalizeRedisError(execErr)
		switch {
		case errors.Is(execErr, goredis.Nil):
			result.Columns = []string{"value"}
			result.ColumnTypes = []string{"nil"}
			result.Rows = [][]any{{nil}}
			result.RowsReturned = 1
			return result, nil
		case errors.Is(normalized, connector.ErrUnavailable), errors.Is(normalized, connector.ErrTimeout), errors.Is(normalized, connector.ErrForbidden):
			return nil, normalized
		default:
			result.Error = normalized.Error()
			return result, nil
		}
	}

	switch typed := value.(type) {
	case nil:
		result.Columns = []string{"value"}
		result.ColumnTypes = []string{"nil"}
		result.Rows = [][]any{{nil}}
	case string:
		columnType := "string"
		if isJSONText(typed) {
			columnType = "json"
		}
		result.Columns = []string{"value"}
		result.ColumnTypes = []string{columnType}
		result.Rows = [][]any{{typed}}
	case []byte:
		text := string(typed)
		columnType := "string"
		if isJSONText(text) {
			columnType = "json"
		}
		result.Columns = []string{"value"}
		result.ColumnTypes = []string{columnType}
		result.Rows = [][]any{{text}}
	case int64, int32, int16, int8, int, uint64, uint32, uint16, uint8, uint, float64, float32:
		result.Columns = []string{"value"}
		result.ColumnTypes = []string{"integer"}
		result.Rows = [][]any{{typed}}
	case bool:
		result.Columns = []string{"value"}
		result.ColumnTypes = []string{"boolean"}
		result.Rows = [][]any{{typed}}
	case []string:
		result.Columns = []string{"index", "value"}
		result.ColumnTypes = []string{"integer", "string"}
		result.Rows = makeIndexedRows(typed)
	case []any:
		if looksLikeHashPairs(args, typed) {
			result.Columns = []string{"field", "value"}
			result.ColumnTypes = []string{"string", "string"}
			result.Rows = makeHashRows(typed)
		} else if rows, ok := sortedSetScoreRows(args, typed); ok {
			result.Columns = []string{"member", "score"}
			result.ColumnTypes = []string{"string", "float"}
			result.Rows = rows
		} else {
			result.Columns = []string{"index", "value"}
			result.ColumnTypes = []string{"integer", "mixed"}
			result.Rows = makeIndexedRowsAny(typed)
		}
	case map[string]any:
		result.Columns = []string{"field", "value"}
		result.ColumnTypes = []string{"string", "mixed"}
		result.Rows = makeMapRows(typed)
	case map[any]any:
		// RESP3 map reply (go-redis v9 default) — e.g. HGETALL, CONFIG GET, XINFO.
		result.Columns = []string{"field", "value"}
		result.ColumnTypes = []string{"string", "mixed"}
		result.Rows = makeAnyKeyMapRows(typed)
	case map[string]string:
		result.Columns = []string{"field", "value"}
		result.ColumnTypes = []string{"string", "string"}
		rows := make([][]any, 0, len(typed))
		keys := make([]string, 0, len(typed))
		for key := range typed {
			keys = append(keys, key)
		}
		sort.Strings(keys)
		for _, key := range keys {
			rows = append(rows, []any{key, typed[key]})
		}
		result.Rows = rows
	default:
		result.Columns = []string{"value"}
		result.ColumnTypes = []string{"mixed"}
		result.Rows = [][]any{{typed}}
	}

	if len(result.Rows) > maxExecResultRows {
		result.Rows = result.Rows[:maxExecResultRows]
		result.Truncated = true
		result.AppliedLimit = maxExecResultRows
	}

	// Final safety pass: coerce every cell into a JSON-encodable value so an
	// exotic RESP3 reply can never produce an empty 200 (json.Marshal failure).
	for i := range result.Rows {
		for j := range result.Rows[i] {
			result.Rows[i][j] = jsonSafeValue(result.Rows[i][j])
		}
	}

	result.RowsReturned = len(result.Rows)
	return result, nil
}

// makeAnyKeyMapRows renders a RESP3 map reply as sorted field/value rows.
func makeAnyKeyMapRows(values map[any]any) [][]any {
	type pair struct {
		key   string
		value any
	}
	pairs := make([]pair, 0, len(values))
	for key, value := range values {
		pairs = append(pairs, pair{key: fmt.Sprint(key), value: jsonSafeValue(value)})
	}
	sort.Slice(pairs, func(i, j int) bool { return pairs[i].key < pairs[j].key })

	rows := make([][]any, 0, len(pairs))
	for _, p := range pairs {
		rows = append(rows, []any{p.key, p.value})
	}
	return rows
}

// jsonSafeValue recursively converts values that json.Marshal cannot handle
// (RESP3 maps keyed by any, raw bytes) into encodable equivalents.
func jsonSafeValue(value any) any {
	switch typed := value.(type) {
	case map[any]any:
		out := make(map[string]any, len(typed))
		for key, inner := range typed {
			out[fmt.Sprint(key)] = jsonSafeValue(inner)
		}
		return out
	case []any:
		out := make([]any, len(typed))
		for i, inner := range typed {
			out[i] = jsonSafeValue(inner)
		}
		return out
	case []byte:
		return string(typed)
	default:
		return value
	}
}

func anySlice(values []string) []any {
	args := make([]any, 0, len(values))
	for _, value := range values {
		args = append(args, value)
	}
	return args
}

func looksLikeHashPairs(args []string, values []any) bool {
	if len(values)%2 != 0 || len(values) == 0 {
		return false
	}
	if len(args) == 0 {
		return false
	}
	switch strings.ToUpper(args[0]) {
	case "HGETALL", "CONFIG", "HELLO":
		return true
	default:
		return false
	}
}

// sortedSetScoreCommands are sorted-set reads whose reply can carry scores.
// ZPOPMIN/ZPOPMAX always pair member+score; the rest only with WITHSCORES.
var sortedSetScoreCommands = map[string]struct{}{
	"ZRANGE": {}, "ZREVRANGE": {}, "ZRANGEBYSCORE": {}, "ZREVRANGEBYSCORE": {},
	"ZDIFF": {}, "ZUNION": {}, "ZINTER": {}, "ZRANDMEMBER": {},
}

func isSortedSetScoreCommand(args []string) bool {
	if len(args) == 0 {
		return false
	}
	switch strings.ToUpper(args[0]) {
	case "ZPOPMIN", "ZPOPMAX":
		return true
	}
	if _, ok := sortedSetScoreCommands[strings.ToUpper(args[0])]; !ok {
		return false
	}
	for _, arg := range args[1:] {
		if strings.EqualFold(arg, "WITHSCORES") {
			return true
		}
	}
	return false
}

// sortedSetScoreRows pairs a sorted-set reply into [member, score] rows. It
// accepts both the RESP2 flat shape ([member, score, member, score, ...]) and
// the RESP3 nested shape ([[member, score], ...]).
func sortedSetScoreRows(args []string, values []any) ([][]any, bool) {
	if !isSortedSetScoreCommand(args) {
		return nil, false
	}

	if len(values) > 0 {
		if _, nested := values[0].([]any); nested {
			rows := make([][]any, 0, len(values))
			for _, element := range values {
				pair, ok := element.([]any)
				if !ok || len(pair) != 2 {
					return nil, false
				}
				rows = append(rows, []any{pair[0], parseRedisScore(pair[1])})
			}
			return rows, true
		}
	}

	if len(values)%2 != 0 {
		return nil, false
	}
	rows := make([][]any, 0, len(values)/2)
	for i := 0; i+1 < len(values); i += 2 {
		rows = append(rows, []any{values[i], parseRedisScore(values[i+1])})
	}
	return rows, true
}

// parseRedisScore normalizes a score to float64 when it arrives as a string
// (RESP2), leaving already-numeric RESP3 scores untouched.
func parseRedisScore(value any) any {
	if text, ok := value.(string); ok {
		if score, err := strconv.ParseFloat(text, 64); err == nil {
			return score
		}
	}
	return value
}

func makeIndexedRows(values []string) [][]any {
	rows := make([][]any, 0, len(values))
	for index, value := range values {
		rows = append(rows, []any{index + 1, value})
	}
	return rows
}

func makeIndexedRowsAny(values []any) [][]any {
	rows := make([][]any, 0, len(values))
	for index, value := range values {
		rows = append(rows, []any{index + 1, value})
	}
	return rows
}

func makeHashRows(values []any) [][]any {
	rows := make([][]any, 0, len(values)/2)
	for i := 0; i+1 < len(values); i += 2 {
		rows = append(rows, []any{values[i], values[i+1]})
	}
	return rows
}

func makeMapRows(values map[string]any) [][]any {
	rows := make([][]any, 0, len(values))
	keys := make([]string, 0, len(values))
	for key := range values {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	for _, key := range keys {
		rows = append(rows, []any{key, values[key]})
	}
	return rows
}

func isJSONText(text string) bool {
	var value any
	return json.Unmarshal([]byte(strings.TrimSpace(text)), &value) == nil
}
