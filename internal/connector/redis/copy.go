package redis

import (
	"context"
	"encoding/json"
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

// keyContent is a key read out in full, before anything decides what to do
// with it. Two renderers hang off this — write commands for a copy, a JSON
// document for the clipboard — and they share one read so the type switch
// cannot drift between them.
type keyContent struct {
	Type   string
	TTLMs  int64
	String string
	Hash   map[string]string
	Items  []string
	ZSet   []goredis.Z
	Stream []goredis.XMessage
	JSON   string
}

func (c *RedisConnector) readKey(ctx context.Context, key string) (*keyContent, error) {
	meta, err := c.getKeyMeta(ctx, key)
	if err != nil {
		return nil, err
	}

	content := &keyContent{Type: meta.keyType}
	if meta.ttl > 0 {
		content.TTLMs = meta.ttl * 1000
	}

	switch meta.keyType {
	case "string":
		content.String, err = c.client.Get(ctx, key).Result()
	case "hash":
		content.Hash, _, err = c.scanHashFields(ctx, key, "")
	case "list":
		content.Items, err = c.client.LRange(ctx, key, 0, -1).Result()
	case "set":
		content.Items, _, err = c.scanSetMembers(ctx, key, "")
	case "zset":
		content.ZSet, err = c.client.ZRangeWithScores(ctx, key, 0, -1).Result()
	case "stream":
		content.Stream, err = c.client.XRangeN(ctx, key, "-", "+", maxScanKeys).Result()
	case "json":
		var raw string
		raw, err = c.client.Do(ctx, "JSON.GET", key, "$").Text()
		content.JSON = unwrapJSONRoot(raw)
	default:
		return nil, unsupportedRedisOperation("read " + meta.keyType + " key")
	}
	if err != nil {
		return nil, normalizeRedisError(err)
	}
	return content, nil
}

// keyWrites is the command sequence that recreates source under destination.
// Each element is a full argument list, ready for Do.
func (c *RedisConnector) keyWrites(ctx context.Context, source, destination string) ([][]any, error) {
	content, err := c.readKey(ctx, source)
	if err != nil {
		return nil, err
	}
	return writesFor(content, source, destination)
}

func writesFor(content *keyContent, source, destination string) ([][]any, error) {
	var writes [][]any
	switch content.Type {
	case "string":
		writes = append(writes, []any{"SET", destination, content.String})

	case "hash":
		args := make([]any, 0, len(content.Hash)*2)
		for field, value := range content.Hash {
			args = append(args, field, value)
		}
		writes = appendChunked(writes, "HSET", destination, args, 2)

	case "list":
		writes = appendChunked(writes, "RPUSH", destination, anySlice(content.Items), 1)

	case "set":
		writes = appendChunked(writes, "SADD", destination, anySlice(content.Items), 1)

	case "zset":
		args := make([]any, 0, len(content.ZSet)*2)
		for _, member := range content.ZSet {
			// Score first, member second — ZADD's argument order, not the
			// display order the viewer uses.
			args = append(args, strconv.FormatFloat(member.Score, 'f', -1, 64), member.Member)
		}
		writes = appendChunked(writes, "ZADD", destination, args, 2)

	case "stream":
		for _, entry := range content.Stream {
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
		writes = append(writes, []any{"JSON.SET", destination, "$", content.JSON})

	default:
		return nil, unsupportedRedisOperation("copy " + content.Type + " key")
	}

	if len(writes) == 0 {
		return nil, fmt.Errorf("%w: key %q is empty and cannot be copied", connector.ErrBadRequest, source)
	}
	if content.TTLMs > 0 {
		writes = append(writes, []any{"PEXPIRE", destination, content.TTLMs})
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

// ExportDocument renders a key as JSON — the shape a person pastes into a chat
// or a file, not the shape Redis stores.
//
// Read whole, server-side, on purpose. The viewer pages large collections, so
// building this in the browser from what happens to be on screen would quietly
// hand someone the first fifty fields of a thousand-field hash and call it the
// key. Reading is all this does, which is why it works on a read-only
// connection: nothing about copying a key out requires the right to change it.
func (c *RedisConnector) ExportDocument(ctx context.Context, key string) (map[string]any, error) {
	content, err := c.readKey(ctx, key)
	if err != nil {
		return nil, err
	}

	doc := map[string]any{"key": key, "type": content.Type}
	if content.TTLMs > 0 {
		doc["ttl_ms"] = content.TTLMs
	}

	switch content.Type {
	case "string":
		doc["value"] = content.String
	case "hash":
		doc["value"] = content.Hash
	case "list", "set":
		// Never null: an empty collection reads as [] in the pasted document,
		// which is a fact, while null is a question.
		items := content.Items
		if items == nil {
			items = []string{}
		}
		doc["value"] = items
	case "zset":
		members := make([]map[string]any, 0, len(content.ZSet))
		for _, member := range content.ZSet {
			members = append(members, map[string]any{"member": member.Member, "score": member.Score})
		}
		doc["value"] = members
	case "stream":
		entries := make([]map[string]any, 0, len(content.Stream))
		for _, entry := range content.Stream {
			entries = append(entries, map[string]any{"id": entry.ID, "fields": entry.Values})
		}
		doc["value"] = entries
	case "json":
		// Already a JSON document; embedded raw so it nests as a value rather
		// than arriving as a string of escaped JSON.
		doc["value"] = jsoniterRaw(content.JSON)
	}

	return doc, nil
}

// jsoniterRaw hands an already-serialized document to the encoder untouched.
// Falls back to the plain string if what Redis returned is not valid JSON,
// which is better than failing the whole export over one odd key.
func jsoniterRaw(raw string) any {
	if json.Valid([]byte(raw)) {
		return json.RawMessage(raw)
	}
	return raw
}
