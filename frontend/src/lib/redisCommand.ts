// Commands whose FIRST argument is the key. (OBJECT/multi-key/mutations excluded —
// their first arg is a subcommand or there is no single key.)
const KEY_FIRST_ARG_COMMANDS = new Set([
  'GET', 'GETRANGE', 'STRLEN', 'TYPE', 'TTL', 'PTTL', 'EXISTS', 'DUMP', 'GETEX',
  'HGETALL', 'HGET', 'HMGET', 'HKEYS', 'HVALS', 'HLEN', 'HEXISTS',
  'SMEMBERS', 'SCARD', 'SISMEMBER', 'SRANDMEMBER',
  'LRANGE', 'LINDEX', 'LLEN',
  'ZRANGE', 'ZREVRANGE', 'ZSCORE', 'ZCARD', 'ZRANK', 'ZREVRANK',
  'XRANGE', 'XLEN',
])

// parseRedisKeyFromCommand returns the key operated on by a single-key read
// command (e.g. "HGETALL profile:1" -> "profile:1"), or null for unknown /
// multi-key / mutating commands.
export function parseRedisKeyFromCommand(statement: string): string | null {
  const tokens = statement.trim().split(/\s+/)
  if (tokens.length < 2) {
    return null
  }
  if (!KEY_FIRST_ARG_COMMANDS.has(tokens[0].toUpperCase())) {
    return null
  }
  return tokens[1]
}
