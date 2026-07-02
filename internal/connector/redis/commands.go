package redis

import (
	"sort"
	"strings"
)

type redisCommandSpec struct {
	Name        string
	Syntax      string
	Group       string
	Description string
}

var redisCommands = []redisCommandSpec{
	{Name: "APPEND", Syntax: "APPEND key value", Group: "string", Description: "Append a value to a string key"},
	{Name: "BITCOUNT", Syntax: "BITCOUNT key [start end [BYTE|BIT]]", Group: "string", Description: "Count set bits in a string"},
	{Name: "BITFIELD", Syntax: "BITFIELD key ...", Group: "string", Description: "Read and modify integer fields in a string"},
	{Name: "BITOP", Syntax: "BITOP operation destkey key [key ...]", Group: "string", Description: "Run bitwise operations between strings"},
	{Name: "BITPOS", Syntax: "BITPOS key bit [start [end [BYTE|BIT]]]", Group: "string", Description: "Find the first bit set or clear"},
	{Name: "DECR", Syntax: "DECR key", Group: "string", Description: "Decrement the integer value of a key"},
	{Name: "DECRBY", Syntax: "DECRBY key decrement", Group: "string", Description: "Decrement a key by a number"},
	{Name: "GET", Syntax: "GET key", Group: "string", Description: "Get the value of a key"},
	{Name: "GETDEL", Syntax: "GETDEL key", Group: "string", Description: "Get and delete the value of a key"},
	{Name: "GETEX", Syntax: "GETEX key [EX seconds|PX milliseconds|PERSIST]", Group: "string", Description: "Get a key and optionally update its TTL"},
	{Name: "GETRANGE", Syntax: "GETRANGE key start end", Group: "string", Description: "Get a substring from a string"},
	{Name: "GETSET", Syntax: "GETSET key value", Group: "string", Description: "Set a new value and return the old one"},
	{Name: "INCR", Syntax: "INCR key", Group: "string", Description: "Increment the integer value of a key"},
	{Name: "INCRBY", Syntax: "INCRBY key increment", Group: "string", Description: "Increment a key by a number"},
	{Name: "INCRBYFLOAT", Syntax: "INCRBYFLOAT key increment", Group: "string", Description: "Increment a key by a floating-point number"},
	{Name: "MGET", Syntax: "MGET key [key ...]", Group: "string", Description: "Get values of multiple keys"},
	{Name: "MSET", Syntax: "MSET key value [key value ...]", Group: "string", Description: "Set multiple keys at once"},
	{Name: "MSETNX", Syntax: "MSETNX key value [key value ...]", Group: "string", Description: "Set multiple keys only if none exist"},
	{Name: "SET", Syntax: "SET key value [EX seconds|PX milliseconds|NX|XX|KEEPTTL]", Group: "string", Description: "Set the value of a key"},
	{Name: "SETEX", Syntax: "SETEX key seconds value", Group: "string", Description: "Set a key with an expiration"},
	{Name: "SETNX", Syntax: "SETNX key value", Group: "string", Description: "Set a key only if it does not exist"},
	{Name: "SETRANGE", Syntax: "SETRANGE key offset value", Group: "string", Description: "Overwrite part of a string"},
	{Name: "STRLEN", Syntax: "STRLEN key", Group: "string", Description: "Get the length of a string"},
	{Name: "HDEL", Syntax: "HDEL key field [field ...]", Group: "hash", Description: "Delete fields from a hash"},
	{Name: "HEXISTS", Syntax: "HEXISTS key field", Group: "hash", Description: "Check if a hash field exists"},
	{Name: "HGET", Syntax: "HGET key field", Group: "hash", Description: "Get a hash field"},
	{Name: "HGETALL", Syntax: "HGETALL key", Group: "hash", Description: "Get all fields and values of a hash"},
	{Name: "HINCRBY", Syntax: "HINCRBY key field increment", Group: "hash", Description: "Increment a hash field by an integer"},
	{Name: "HINCRBYFLOAT", Syntax: "HINCRBYFLOAT key field increment", Group: "hash", Description: "Increment a hash field by a float"},
	{Name: "HKEYS", Syntax: "HKEYS key", Group: "hash", Description: "Get all field names in a hash"},
	{Name: "HLEN", Syntax: "HLEN key", Group: "hash", Description: "Get the number of fields in a hash"},
	{Name: "HMGET", Syntax: "HMGET key field [field ...]", Group: "hash", Description: "Get multiple hash fields"},
	{Name: "HMSET", Syntax: "HMSET key field value [field value ...]", Group: "hash", Description: "Set multiple hash fields"},
	{Name: "HRANDFIELD", Syntax: "HRANDFIELD key [count [WITHVALUES]]", Group: "hash", Description: "Get one or more random fields from a hash"},
	{Name: "HSET", Syntax: "HSET key field value [field value ...]", Group: "hash", Description: "Set one or more hash fields"},
	{Name: "HSETNX", Syntax: "HSETNX key field value", Group: "hash", Description: "Set a hash field only if it does not exist"},
	{Name: "HSTRLEN", Syntax: "HSTRLEN key field", Group: "hash", Description: "Get the length of a hash field value"},
	{Name: "HVALS", Syntax: "HVALS key", Group: "hash", Description: "Get all values in a hash"},
	{Name: "BLMOVE", Syntax: "BLMOVE source destination LEFT|RIGHT LEFT|RIGHT timeout", Group: "list", Description: "Pop from a list and push to another"},
	{Name: "BLPOP", Syntax: "BLPOP key [key ...] timeout", Group: "list", Description: "Blocking pop from the head of a list"},
	{Name: "BRPOP", Syntax: "BRPOP key [key ...] timeout", Group: "list", Description: "Blocking pop from the tail of a list"},
	{Name: "BRPOPLPUSH", Syntax: "BRPOPLPUSH source destination timeout", Group: "list", Description: "Blocking RPOPLPUSH"},
	{Name: "LINDEX", Syntax: "LINDEX key index", Group: "list", Description: "Get an element by index from a list"},
	{Name: "LINSERT", Syntax: "LINSERT key BEFORE|AFTER pivot element", Group: "list", Description: "Insert into a list"},
	{Name: "LLEN", Syntax: "LLEN key", Group: "list", Description: "Get the length of a list"},
	{Name: "LMOVE", Syntax: "LMOVE source destination LEFT|RIGHT LEFT|RIGHT", Group: "list", Description: "Pop from one list and push to another"},
	{Name: "LPOP", Syntax: "LPOP key [count]", Group: "list", Description: "Pop elements from the head of a list"},
	{Name: "LPOS", Syntax: "LPOS key element [RANK rank] [COUNT num-matches] [MAXLEN len]", Group: "list", Description: "Find the index of an element in a list"},
	{Name: "LPUSH", Syntax: "LPUSH key element [element ...]", Group: "list", Description: "Push elements to the head of a list"},
	{Name: "LPUSHX", Syntax: "LPUSHX key element [element ...]", Group: "list", Description: "Push to a list only if it exists"},
	{Name: "LRANGE", Syntax: "LRANGE key start stop", Group: "list", Description: "Get a range of elements from a list"},
	{Name: "LREM", Syntax: "LREM key count element", Group: "list", Description: "Remove elements from a list"},
	{Name: "LSET", Syntax: "LSET key index element", Group: "list", Description: "Set a list element by index"},
	{Name: "LTRIM", Syntax: "LTRIM key start stop", Group: "list", Description: "Trim a list to a range"},
	{Name: "RPOP", Syntax: "RPOP key [count]", Group: "list", Description: "Pop elements from the tail of a list"},
	{Name: "RPOPLPUSH", Syntax: "RPOPLPUSH source destination", Group: "list", Description: "Pop from one list and push to another"},
	{Name: "RPUSH", Syntax: "RPUSH key element [element ...]", Group: "list", Description: "Push elements to the tail of a list"},
	{Name: "RPUSHX", Syntax: "RPUSHX key element [element ...]", Group: "list", Description: "Push to a list only if it exists"},
	{Name: "SADD", Syntax: "SADD key member [member ...]", Group: "set", Description: "Add members to a set"},
	{Name: "SCARD", Syntax: "SCARD key", Group: "set", Description: "Get the number of members in a set"},
	{Name: "SDIFF", Syntax: "SDIFF key [key ...]", Group: "set", Description: "Subtract multiple sets"},
	{Name: "SDIFFSTORE", Syntax: "SDIFFSTORE destination key [key ...]", Group: "set", Description: "Store the difference of sets"},
	{Name: "SINTER", Syntax: "SINTER key [key ...]", Group: "set", Description: "Intersect multiple sets"},
	{Name: "SINTERCARD", Syntax: "SINTERCARD numkeys key [key ...] [LIMIT limit]", Group: "set", Description: "Get the size of set intersection"},
	{Name: "SINTERSTORE", Syntax: "SINTERSTORE destination key [key ...]", Group: "set", Description: "Store the intersection of sets"},
	{Name: "SISMEMBER", Syntax: "SISMEMBER key member", Group: "set", Description: "Check membership in a set"},
	{Name: "SMEMBERS", Syntax: "SMEMBERS key", Group: "set", Description: "Get all set members"},
	{Name: "SMISMEMBER", Syntax: "SMISMEMBER key member [member ...]", Group: "set", Description: "Check membership for multiple set members"},
	{Name: "SMOVE", Syntax: "SMOVE source destination member", Group: "set", Description: "Move a member between sets"},
	{Name: "SPOP", Syntax: "SPOP key [count]", Group: "set", Description: "Pop random members from a set"},
	{Name: "SRANDMEMBER", Syntax: "SRANDMEMBER key [count]", Group: "set", Description: "Get random members from a set"},
	{Name: "SREM", Syntax: "SREM key member [member ...]", Group: "set", Description: "Remove members from a set"},
	{Name: "SSCAN", Syntax: "SSCAN key cursor [MATCH pattern] [COUNT count]", Group: "set", Description: "Incrementally iterate set members"},
	{Name: "SUNION", Syntax: "SUNION key [key ...]", Group: "set", Description: "Union multiple sets"},
	{Name: "SUNIONSTORE", Syntax: "SUNIONSTORE destination key [key ...]", Group: "set", Description: "Store the union of sets"},
	{Name: "BZPOPMAX", Syntax: "BZPOPMAX key [key ...] timeout", Group: "sorted-set", Description: "Blocking pop max score member"},
	{Name: "BZPOPMIN", Syntax: "BZPOPMIN key [key ...] timeout", Group: "sorted-set", Description: "Blocking pop min score member"},
	{Name: "ZADD", Syntax: "ZADD key [NX|XX] [GT|LT] [CH] [INCR] score member [score member ...]", Group: "sorted-set", Description: "Add members to a sorted set"},
	{Name: "ZCARD", Syntax: "ZCARD key", Group: "sorted-set", Description: "Get the number of members in a sorted set"},
	{Name: "ZCOUNT", Syntax: "ZCOUNT key min max", Group: "sorted-set", Description: "Count members in a score range"},
	{Name: "ZDIFF", Syntax: "ZDIFF numkeys key [key ...] [WITHSCORES]", Group: "sorted-set", Description: "Subtract sorted sets"},
	{Name: "ZINCRBY", Syntax: "ZINCRBY key increment member", Group: "sorted-set", Description: "Increment the score of a sorted set member"},
	{Name: "ZINTER", Syntax: "ZINTER numkeys key [key ...] [WEIGHTS weight ...] [AGGREGATE SUM|MIN|MAX] [WITHSCORES]", Group: "sorted-set", Description: "Intersect sorted sets"},
	{Name: "ZLEXCOUNT", Syntax: "ZLEXCOUNT key min max", Group: "sorted-set", Description: "Count members in a lexicographic range"},
	{Name: "ZPOPMAX", Syntax: "ZPOPMAX key [count]", Group: "sorted-set", Description: "Pop max score members"},
	{Name: "ZPOPMIN", Syntax: "ZPOPMIN key [count]", Group: "sorted-set", Description: "Pop min score members"},
	{Name: "ZRANDMEMBER", Syntax: "ZRANDMEMBER key [count [WITHSCORES]]", Group: "sorted-set", Description: "Get random members from a sorted set"},
	{Name: "ZRANGE", Syntax: "ZRANGE key start stop [BYSCORE|BYLEX] [REV] [LIMIT offset count] [WITHSCORES]", Group: "sorted-set", Description: "Return a range from a sorted set"},
	{Name: "ZRANGEBYSCORE", Syntax: "ZRANGEBYSCORE key min max [WITHSCORES] [LIMIT offset count]", Group: "sorted-set", Description: "Return members in a score range"},
	{Name: "ZRANK", Syntax: "ZRANK key member [WITHSCORE]", Group: "sorted-set", Description: "Get the rank of a member"},
	{Name: "ZREM", Syntax: "ZREM key member [member ...]", Group: "sorted-set", Description: "Remove members from a sorted set"},
	{Name: "ZREMRANGEBYLEX", Syntax: "ZREMRANGEBYLEX key min max", Group: "sorted-set", Description: "Remove members in a lexicographic range"},
	{Name: "ZREMRANGEBYRANK", Syntax: "ZREMRANGEBYRANK key start stop", Group: "sorted-set", Description: "Remove members by rank"},
	{Name: "ZREMRANGEBYSCORE", Syntax: "ZREMRANGEBYSCORE key min max", Group: "sorted-set", Description: "Remove members by score"},
	{Name: "ZREVRANGE", Syntax: "ZREVRANGE key start stop [WITHSCORES]", Group: "sorted-set", Description: "Return a reverse range from a sorted set"},
	{Name: "ZREVRANGEBYSCORE", Syntax: "ZREVRANGEBYSCORE key max min [WITHSCORES] [LIMIT offset count]", Group: "sorted-set", Description: "Return members in reverse score order"},
	{Name: "ZREVRANK", Syntax: "ZREVRANK key member [WITHSCORE]", Group: "sorted-set", Description: "Get the reverse rank of a member"},
	{Name: "ZSCORE", Syntax: "ZSCORE key member", Group: "sorted-set", Description: "Get the score of a sorted set member"},
	{Name: "ZUNION", Syntax: "ZUNION numkeys key [key ...] [WEIGHTS weight ...] [AGGREGATE SUM|MIN|MAX] [WITHSCORES]", Group: "sorted-set", Description: "Union sorted sets"},
	{Name: "XACK", Syntax: "XACK key group ID [ID ...]", Group: "stream", Description: "Acknowledge stream entries"},
	{Name: "XADD", Syntax: "XADD key [NOMKSTREAM] [MAXLEN|MINID ...] ID field value [field value ...]", Group: "stream", Description: "Append an entry to a stream"},
	{Name: "XAUTOCLAIM", Syntax: "XAUTOCLAIM key group consumer min-idle-time start [COUNT count]", Group: "stream", Description: "Claim idle pending stream entries"},
	{Name: "XCLAIM", Syntax: "XCLAIM key group consumer min-idle-time ID [ID ...]", Group: "stream", Description: "Claim pending stream entries"},
	{Name: "XDEL", Syntax: "XDEL key ID [ID ...]", Group: "stream", Description: "Delete stream entries"},
	{Name: "XGROUP", Syntax: "XGROUP CREATE|SETID|DESTROY|CREATECONSUMER|DELCONSUMER ...", Group: "stream", Description: "Manage consumer groups"},
	{Name: "XINFO", Syntax: "XINFO STREAM|GROUPS|CONSUMERS key [group]", Group: "stream", Description: "Inspect stream internals"},
	{Name: "XLEN", Syntax: "XLEN key", Group: "stream", Description: "Get the length of a stream"},
	{Name: "XPENDING", Syntax: "XPENDING key group [start end count [consumer]]", Group: "stream", Description: "Inspect pending stream entries"},
	{Name: "XRANGE", Syntax: "XRANGE key start end [COUNT count]", Group: "stream", Description: "Read stream entries in forward order"},
	{Name: "XREAD", Syntax: "XREAD [COUNT count] [BLOCK milliseconds] STREAMS key [key ...] id [id ...]", Group: "stream", Description: "Read from one or more streams"},
	{Name: "XREADGROUP", Syntax: "XREADGROUP GROUP group consumer [COUNT count] [BLOCK milliseconds] STREAMS key [key ...] id [id ...]", Group: "stream", Description: "Read from a stream consumer group"},
	{Name: "XREVRANGE", Syntax: "XREVRANGE key end start [COUNT count]", Group: "stream", Description: "Read stream entries in reverse order"},
	{Name: "XTRIM", Syntax: "XTRIM key MAXLEN|MINID ...", Group: "stream", Description: "Trim a stream"},
	{Name: "JSON.ARRAPPEND", Syntax: "JSON.ARRAPPEND key path value [value ...]", Group: "json", Description: "Append values to a JSON array"},
	{Name: "JSON.ARRLEN", Syntax: "JSON.ARRLEN key [path]", Group: "json", Description: "Get the length of JSON arrays"},
	{Name: "JSON.DEL", Syntax: "JSON.DEL key [path]", Group: "json", Description: "Delete JSON values"},
	{Name: "JSON.GET", Syntax: "JSON.GET key [path ...]", Group: "json", Description: "Get a JSON value"},
	{Name: "JSON.NUMINCRBY", Syntax: "JSON.NUMINCRBY key path value", Group: "json", Description: "Increment a numeric JSON value"},
	{Name: "JSON.OBJKEYS", Syntax: "JSON.OBJKEYS key [path]", Group: "json", Description: "Get keys from a JSON object"},
	{Name: "JSON.SET", Syntax: "JSON.SET key path value [NX|XX]", Group: "json", Description: "Set a JSON value"},
	{Name: "JSON.TYPE", Syntax: "JSON.TYPE key [path]", Group: "json", Description: "Get the type of a JSON value"},
	{Name: "COPY", Syntax: "COPY source destination [DB destination-db] [REPLACE]", Group: "key", Description: "Copy a key"},
	{Name: "DEL", Syntax: "DEL key [key ...]", Group: "key", Description: "Delete one or more keys"},
	{Name: "DUMP", Syntax: "DUMP key", Group: "key", Description: "Serialize a key"},
	{Name: "EXISTS", Syntax: "EXISTS key [key ...]", Group: "key", Description: "Check if keys exist"},
	{Name: "EXPIRE", Syntax: "EXPIRE key seconds [NX|XX|GT|LT]", Group: "key", Description: "Set a timeout on a key"},
	{Name: "EXPIREAT", Syntax: "EXPIREAT key unix-time-seconds [NX|XX|GT|LT]", Group: "key", Description: "Set a timeout at a Unix timestamp"},
	{Name: "KEYS", Syntax: "KEYS pattern", Group: "key", Description: "Find keys by pattern"},
	{Name: "MOVE", Syntax: "MOVE key db", Group: "key", Description: "Move a key to another database"},
	{Name: "PERSIST", Syntax: "PERSIST key", Group: "key", Description: "Remove the TTL from a key"},
	{Name: "PEXPIRE", Syntax: "PEXPIRE key milliseconds [NX|XX|GT|LT]", Group: "key", Description: "Set a timeout in milliseconds"},
	{Name: "PTTL", Syntax: "PTTL key", Group: "key", Description: "Get the TTL in milliseconds"},
	{Name: "RANDOMKEY", Syntax: "RANDOMKEY", Group: "key", Description: "Return a random key"},
	{Name: "RENAME", Syntax: "RENAME key newkey", Group: "key", Description: "Rename a key"},
	{Name: "RENAMENX", Syntax: "RENAMENX key newkey", Group: "key", Description: "Rename a key only if the new key does not exist"},
	{Name: "RESTORE", Syntax: "RESTORE key ttl serialized-value [REPLACE]", Group: "key", Description: "Create a key from serialized data"},
	{Name: "SCAN", Syntax: "SCAN cursor [MATCH pattern] [COUNT count] [TYPE type]", Group: "key", Description: "Incrementally iterate keys"},
	{Name: "TOUCH", Syntax: "TOUCH key [key ...]", Group: "key", Description: "Alter the last access time of keys"},
	{Name: "TTL", Syntax: "TTL key", Group: "key", Description: "Get the TTL in seconds"},
	{Name: "TYPE", Syntax: "TYPE key", Group: "key", Description: "Get the type of a key"},
	{Name: "UNLINK", Syntax: "UNLINK key [key ...]", Group: "key", Description: "Asynchronously delete keys"},
	{Name: "DBSIZE", Syntax: "DBSIZE", Group: "server", Description: "Count keys in the selected database"},
	{Name: "ECHO", Syntax: "ECHO message", Group: "server", Description: "Echo a message"},
	{Name: "FLUSHALL", Syntax: "FLUSHALL [ASYNC|SYNC]", Group: "server", Description: "Remove all keys from all databases"},
	{Name: "FLUSHDB", Syntax: "FLUSHDB [ASYNC|SYNC]", Group: "server", Description: "Remove all keys from the current database"},
	{Name: "INFO", Syntax: "INFO [section [section ...]]", Group: "server", Description: "Get server information"},
	{Name: "LASTSAVE", Syntax: "LASTSAVE", Group: "server", Description: "Get the last successful save time"},
	{Name: "PING", Syntax: "PING [message]", Group: "server", Description: "Ping the server"},
	{Name: "ROLE", Syntax: "ROLE", Group: "server", Description: "Get the role of the instance"},
	{Name: "SAVE", Syntax: "SAVE", Group: "server", Description: "Synchronously save the dataset to disk"},
	{Name: "SELECT", Syntax: "SELECT index", Group: "server", Description: "Change the selected database"},
	{Name: "TIME", Syntax: "TIME", Group: "server", Description: "Get server time"},
}

var redisCommandIndex = func() map[string]redisCommandSpec {
	index := make(map[string]redisCommandSpec, len(redisCommands))
	for _, command := range redisCommands {
		index[command.Name] = command
	}
	return index
}()

var redisCommandNames = func() []string {
	names := make([]string, 0, len(redisCommands))
	for _, command := range redisCommands {
		names = append(names, command.Name)
	}
	sort.Strings(names)
	return names
}()

func lookupRedisCommand(name string) (redisCommandSpec, bool) {
	command, ok := redisCommandIndex[strings.ToUpper(strings.TrimSpace(name))]
	return command, ok
}
