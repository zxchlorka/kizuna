package redis

import (
	"context"
	"errors"
	"fmt"
	"strconv"
	"strings"

	goredis "github.com/redis/go-redis/v9"

	"github.com/zxchlorka/kizuna/internal/connector"
)

// Rebuilding a key out of ordinary write commands, for servers that will not
// run RESTORE.
//
// DUMP/RESTORE stays the preferred path everywhere: it is one round trip per
// side, atomic, and byte-exact — it carries the encoding, and for a stream it
// carries entry ids that no sequence of writes can reproduce as faithfully.
// But RESTORE is its own ACL permission, and a user allowed to write keys is
// routinely not allowed to restore them. That user can still build the key by
// hand, which is what this does: read it with the same commands the viewer
// already uses, write it back with SET/HSET/RPUSH/SADD/ZADD/XADD.
//
// The cost is honest and worth stating: this path is not atomic, and it pulls
// the whole key through the process. A hash of a million fields goes over the
// wire twice. Which is why it is the fallback and not the default.

// writeChunk caps how many elements ride in one command. Redis accepts far
// more, but a single enormous command is one thing that can fail and take the
// whole copy with it.
const writeChunk = 500

// keyWrites is the command sequence that recreates source under destination.
// Each element is a full argument list, ready for Do.
func (c *RedisConnector) keyWrites(ctx context.Context, source, destination string) ([][]any, error) {
	meta, err := c.getKeyMeta(ctx, source)
	if err != nil {
		return nil, err
	}

	var writes [][]any
	switch meta.keyType {
	case "string":
		value, err := c.client.Get(ctx, source).Result()
		if err != nil {
			return nil, normalizeRedisError(err)
		}
		writes = append(writes, []any{"SET", destination, value})

	case "hash":
		fields, _, err := c.scanHashFields(ctx, source, "")
		if err != nil {
			return nil, err
		}
		args := make([]any, 0, len(fields)*2)
		for field, value := range fields {
			args = append(args, field, value)
		}
		writes = appendChunked(writes, "HSET", destination, args, 2)

	case "list":
		values, err := c.client.LRange(ctx, source, 0, -1).Result()
		if err != nil {
			return nil, normalizeRedisError(err)
		}
		writes = appendChunked(writes, "RPUSH", destination, anySlice(values), 1)

	case "set":
		members, _, err := c.scanSetMembers(ctx, source, "")
		if err != nil {
			return nil, err
		}
		writes = appendChunked(writes, "SADD", destination, anySlice(members), 1)

	case "zset":
		members, err := c.client.ZRangeWithScores(ctx, source, 0, -1).Result()
		if err != nil {
			return nil, normalizeRedisError(err)
		}
		args := make([]any, 0, len(members)*2)
		for _, member := range members {
			// Score first, member second — ZADD's argument order, not the
			// display order the viewer uses.
			args = append(args, strconv.FormatFloat(member.Score, 'f', -1, 64), member.Member)
		}
		writes = appendChunked(writes, "ZADD", destination, args, 2)

	case "stream":
		entries, err := c.client.XRangeN(ctx, source, "-", "+", maxScanKeys).Result()
		if err != nil {
			return nil, normalizeRedisError(err)
		}
		for _, entry := range entries {
			// The original id is given explicitly so the copy keeps the stream's
			// ordering and its time component. Consumer groups are NOT copied:
			// they are server state about readers, not content, and inventing
			// them on the destination would be a lie about who has read what.
			args := []any{"XADD", destination, entry.ID}
			for field, value := range entry.Values {
				args = append(args, field, value)
			}
			writes = append(writes, args)
		}

	case "json":
		raw, err := c.client.Do(ctx, "JSON.GET", source, "$").Text()
		if err != nil {
			return nil, normalizeRedisError(err)
		}
		writes = append(writes, []any{"JSON.SET", destination, "$", unwrapJSONRoot(raw)})

	default:
		return nil, unsupportedRedisOperation("copy " + meta.keyType + " key")
	}

	if len(writes) == 0 {
		return nil, fmt.Errorf("%w: key %q is empty and cannot be copied", connector.ErrBadRequest, source)
	}
	if meta.ttl > 0 {
		writes = append(writes, []any{"PEXPIRE", destination, meta.ttl * 1000})
	}
	return writes, nil
}

// appendChunked splits args into commands of at most writeChunk elements, where
// one element is `stride` arguments — a field/value pair for HSET, a single
// member for SADD.
func appendChunked(writes [][]any, command, destination string, args []any, stride int) [][]any {
	return appendChunkedWith(writeChunk, writes, command, destination, args, stride)
}

// appendChunkedWith is appendChunked with the chunk size given, so a test can
// exercise the split without building five hundred fields.
func appendChunkedWith(chunk int, writes [][]any, command, destination string, args []any, stride int) [][]any {
	size := chunk * stride
	for start := 0; start < len(args); start += size {
		end := start + size
		if end > len(args) {
			end = len(args)
		}
		chunk := make([]any, 0, end-start+2)
		chunk = append(chunk, command, destination)
		chunk = append(chunk, args[start:end]...)
		writes = append(writes, chunk)
	}
	return writes
}

// unwrapJSONRoot turns JSON.GET's "$" answer, which is an array holding the one
// matched root, back into the document itself. Written straight back it would
// nest the whole document inside an array one level deeper on every copy.
func unwrapJSONRoot(raw string) string {
	trimmed := strings.TrimSpace(raw)
	if len(trimmed) >= 2 && trimmed[0] == '[' && trimmed[len(trimmed)-1] == ']' {
		return strings.TrimSpace(trimmed[1 : len(trimmed)-1])
	}
	return trimmed
}

// runWrites applies a command sequence, stopping at the first failure. A
// partially built key is left in place rather than cleaned up: deleting it would
// need DEL, which a user this restricted may not have either, and silently
// removing a key after a failed write is worse than leaving evidence.
func (c *RedisConnector) runWrites(ctx context.Context, writes [][]any) error {
	for _, args := range writes {
		if err := c.client.Do(ctx, args...).Err(); err != nil {
			return normalizeRedisError(err)
		}
	}
	return nil
}

// ExportKey packages a key for another connection. See connector.KeyExport for
// why there are two representations.
func (c *RedisConnector) ExportKey(ctx context.Context, key string, plain bool) (*connector.KeyExport, error) {
	meta, err := c.getKeyMeta(ctx, key)
	if err != nil {
		return nil, err
	}

	export := &connector.KeyExport{Type: meta.keyType}
	if meta.ttl > 0 {
		export.TTLMs = meta.ttl * 1000
	}

	if !plain {
		payload, dumpErr := c.client.Do(ctx, "DUMP", key).Text()
		if dumpErr == nil {
			export.Dump = payload
			return export, nil
		}
		if errors.Is(dumpErr, goredis.Nil) {
			return nil, fmt.Errorf("%w: key %q not found", connector.ErrRelationNotFound, key)
		}
		if !errors.Is(normalizeRedisError(dumpErr), connector.ErrForbidden) {
			return nil, normalizeRedisError(dumpErr)
		}
		// DUMP refused — fall through and build the plain form instead.
	}

	// The key's own name stands in for the destination; ImportKey rewrites it.
	writes, err := c.keyWrites(ctx, key, key)
	if err != nil {
		return nil, err
	}
	export.Writes = writes
	return export, nil
}

// ImportKey recreates an exported key under `key`, refusing to overwrite.
func (c *RedisConnector) ImportKey(ctx context.Context, key string, export *connector.KeyExport) error {
	if export == nil {
		return fmt.Errorf("%w: nothing to import", connector.ErrBadRequest)
	}
	if strings.TrimSpace(key) == "" {
		return fmt.Errorf("%w: destination key is required", connector.ErrBadRequest)
	}
	if c.config.ReadOnly {
		return fmt.Errorf("%w: connection is read-only", connector.ErrReadOnly)
	}

	// Never silently replace. A transfer that lands on an existing key is far
	// more likely to be a mistyped name than an intended overwrite.
	exists, err := c.client.Exists(ctx, key).Result()
	if err != nil {
		return normalizeRedisError(err)
	}
	if exists > 0 {
		return fmt.Errorf("%w: key %q already exists", connector.ErrBadRequest, key)
	}

	if export.Dump != "" {
		err := c.client.Do(ctx, "RESTORE", key, export.TTLMs, export.Dump).Err()
		if err == nil {
			c.invalidateKeyMeta(key)
			return nil
		}
		// Reported as-is so the caller can re-export in plain form and retry.
		return normalizeRedisError(err)
	}

	if len(export.Writes) == 0 {
		return fmt.Errorf("%w: the source produced nothing to write", connector.ErrBadRequest)
	}
	if err := c.runWrites(ctx, retargetWrites(export.Writes, key)); err != nil {
		return err
	}
	c.invalidateKeyMeta(key)
	return nil
}

// retargetWrites points a command sequence at another key name. Every command
// keyWrites builds carries the key at index 1, which is where Redis write
// commands take it.
func retargetWrites(writes [][]any, key string) [][]any {
	out := make([][]any, 0, len(writes))
	for _, args := range writes {
		if len(args) < 2 {
			continue
		}
		retargeted := make([]any, len(args))
		copy(retargeted, args)
		retargeted[1] = key
		out = append(out, retargeted)
	}
	return out
}
