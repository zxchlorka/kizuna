package redis

import "strings"

// redisReadOnlyCommands is the allowlist of commands permitted on a read-only
// connection. Enforcement is fail-closed: anything not listed here (writes and
// unknown commands) is rejected. Commands with read+write forms or side effects
// on TTL/state (GETEX, GETDEL, SORT, BITFIELD, CONFIG, COPY, …) are deliberately
// excluded so they cannot slip through.
var redisReadOnlyCommands = map[string]struct{}{
	// strings
	"GET": {}, "GETRANGE": {}, "SUBSTR": {}, "MGET": {}, "STRLEN": {},
	"BITCOUNT": {}, "BITPOS": {}, "GETBIT": {},
	// hashes
	"HGET": {}, "HGETALL": {}, "HKEYS": {}, "HVALS": {}, "HLEN": {},
	"HMGET": {}, "HEXISTS": {}, "HSTRLEN": {}, "HRANDFIELD": {}, "HSCAN": {},
	// lists
	"LLEN": {}, "LRANGE": {}, "LINDEX": {}, "LPOS": {},
	// sets
	"SCARD": {}, "SMEMBERS": {}, "SISMEMBER": {}, "SMISMEMBER": {},
	"SRANDMEMBER": {}, "SSCAN": {}, "SINTER": {}, "SUNION": {}, "SDIFF": {},
	"SINTERCARD": {},
	// sorted sets
	"ZCARD": {}, "ZCOUNT": {}, "ZSCORE": {}, "ZMSCORE": {}, "ZRANK": {},
	"ZREVRANK": {}, "ZRANGE": {}, "ZRANGEBYSCORE": {}, "ZRANGEBYLEX": {},
	"ZREVRANGE": {}, "ZREVRANGEBYSCORE": {}, "ZREVRANGEBYLEX": {},
	"ZRANDMEMBER": {}, "ZSCAN": {}, "ZLEXCOUNT": {}, "ZDIFF": {},
	"ZINTER": {}, "ZUNION": {}, "ZINTERCARD": {},
	// streams
	"XLEN": {}, "XRANGE": {}, "XREVRANGE": {}, "XREAD": {}, "XINFO": {},
	"XPENDING": {},
	// keys / generic
	"TYPE": {}, "TTL": {}, "PTTL": {}, "EXISTS": {}, "KEYS": {}, "SCAN": {},
	"RANDOMKEY": {}, "DUMP": {}, "OBJECT": {}, "EXPIRETIME": {}, "PEXPIRETIME": {},
	"TOUCH": {}, "MEMORY": {},
	// JSON (RedisJSON read commands)
	"JSON.GET": {}, "JSON.TYPE": {}, "JSON.ARRLEN": {}, "JSON.OBJKEYS": {},
	"JSON.OBJLEN": {}, "JSON.STRLEN": {}, "JSON.ARRINDEX": {}, "JSON.RESP": {},
	"JSON.MGET": {},
	// server / connection (non-mutating)
	"INFO": {}, "PING": {}, "ECHO": {}, "TIME": {}, "LASTSAVE": {}, "ROLE": {},
	"DBSIZE": {}, "SELECT": {}, "COMMAND": {}, "HELLO": {},
}

// isRedisReadOnlyCommand reports whether the command is safe on a read-only
// connection. The name is matched case-insensitively.
func isRedisReadOnlyCommand(name string) bool {
	_, ok := redisReadOnlyCommands[strings.ToUpper(strings.TrimSpace(name))]
	return ok
}
