import type { ColumnMeta, LinkRecord, TableRow } from '@/types/api'
import { parsePath, traverse } from '@/lib/jsonPaths'

// extractMessageField parses a Kafka message JSON value and returns the scalar
// at a canonical path (e.g. "user_id", "user.id", "items[].id",
// ["key.with.dot"].name — see lib/jsonPaths.ts). It returns the FIRST scalar
// leaf the path resolves to, or null when the value is not JSON, the path
// resolves to no leaf, or the leaf is null/an object/an array (not a linkable
// scalar). Existing simple dot-path links resolve identically to before; the
// array/bracket grammar is purely additive.
export function extractMessageField(value: string, field: string): string | null {
  if (!field) {
    return null
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    return null
  }
  const segments = parsePath(field)
  if (segments.length === 0) {
    return null
  }
  for (const leaf of traverse(parsed, segments)) {
    if (leaf !== null && typeof leaf !== 'object') {
      return String(leaf)
    }
  }
  return null
}

// buildRedisKey replaces the single '*' in a pattern with the value.
export function buildRedisKey(pattern: string, value: string): string {
  return pattern.replace('*', value)
}

export function redisKeyMatchesPattern(pattern: string, key: string): boolean {
  const star = pattern.indexOf('*')
  if (star < 0) {
    return pattern === key
  }
  const prefix = pattern.slice(0, star)
  const suffix = pattern.slice(star + 1)
  return key.length >= prefix.length + suffix.length && key.startsWith(prefix) && key.endsWith(suffix)
}

export function captureFromKey(pattern: string, key: string): string | null {
  if (!redisKeyMatchesPattern(pattern, key)) {
    return null
  }
  const star = pattern.indexOf('*')
  if (star < 0) {
    return null
  }
  const prefix = pattern.slice(0, star)
  const suffix = pattern.slice(star + 1)
  return key.slice(prefix.length, key.length - suffix.length)
}

export function extractPgColumn(_columns: ColumnMeta[], row: TableRow, column: string): string | null {
  const value = row[column]
  if (value === null || value === undefined || typeof value === 'object') {
    return null
  }
  return String(value)
}

export function extractRedisValue(
  link: LinkRecord,
  keyName: string,
  stringValue: string,
  hashRows: TableRow[]
): string | null {
  switch (link.source_extract) {
    case 'key_capture':
      return captureFromKey(link.source_scope, keyName)
    case 'string_value':
      return stringValue === '' ? null : stringValue
    case 'value_field': {
      if (!link.source_field) {
        return null
      }
      const hashHit = hashRows.find((r) => String(r.field ?? '') === link.source_field)
      if (hashHit && hashHit.value !== undefined && hashHit.value !== null && typeof hashHit.value !== 'object') {
        return String(hashHit.value)
      }
      return extractMessageField(stringValue, link.source_field)
    }
    default:
      return null
  }
}

export function linkTargetLabel(link: LinkRecord, value: string | null): string {
  const shown = value ?? '∅'
  if (link.target_kind === 'redis') {
    return `Redis: ${(link.key_pattern ?? '').replace('*', shown)}`
  }
  if (link.target_kind === 'postgres') {
    return `Postgres: ${link.table}.${link.column} = ${shown}`
  }
  return `Kafka: ${link.target_topic} where ${link.target_field} = ${shown}`
}

// suggestKeyPattern proposes a key pattern scope for a concrete redis key by
// replacing the segment after the last ':' with '*' (e.g. profile:42 -> profile:*).
export function suggestKeyPattern(key: string): string {
  const lastColon = key.lastIndexOf(':')
  return lastColon >= 0 ? `${key.slice(0, lastColon + 1)}*` : key
}

// canReverse reports whether a link's source can be reached from its target.
// Redis sources only reverse when the value was captured from the key name
// (key_capture); value_field/string_value would require a redis content scan.
export function canReverse(link: LinkRecord): boolean {
  if (link.source_kind === 'redis') {
    return link.source_extract === 'key_capture'
  }
  return true
}

// linkSourceLabel renders a "back to source" menu label for a resolved value.
export function linkSourceLabel(link: LinkRecord, value: string | null): string {
  const shown = value ?? '∅'
  if (link.source_kind === 'kafka') {
    return `↩ ${link.source_scope} where ${link.source_field} = ${shown}`
  }
  if (link.source_kind === 'postgres') {
    return `↩ ${link.source_scope}.${link.source_field} = ${shown}`
  }
  return `↩ ${link.source_scope.replace('*', shown)}`
}

// Per-element линк берёт значение из того, на что пользователь указал в UI
// (элемент коллекции или фрагмент значения), а не из ключа целиком. У него нет
// значения на уровне ключа, поэтому в шапке он показывается справочно.
export function isPerElementExtract(extract?: string): boolean {
  return extract === 'member' || extract === 'selection'
}

function isRedisSource(link: LinkRecord, connId: string, key: string): boolean {
  return (
    link.source_conn_id === connId &&
    link.source_kind === 'redis' &&
    redisKeyMatchesPattern(link.source_scope, key)
  )
}

// keyLevelRedisLinks — линки, у которых значение вычисляется из самого ключа
// (key_capture / string_value / value_field). Только они кликабельны в шапке.
export function keyLevelRedisLinks(links: LinkRecord[], connId: string, key: string): LinkRecord[] {
  return links.filter((link) => isRedisSource(link, connId, key) && !isPerElementExtract(link.source_extract))
}

export function memberRedisLinks(links: LinkRecord[], connId: string, key: string): LinkRecord[] {
  return links.filter((link) => isRedisSource(link, connId, key) && link.source_extract === 'member')
}

// selectionRedisLinks — линки, применимые к точке, по которой кликнули. Линк с
// заданным source_field сужен до одного хэш-поля (cookie_ids → c:*), линк без
// поля работает в любом месте ключа. Поле undefined означает «кликнули не по
// хэш-строке» (элемент set/zset/list), тогда подходят только линки без поля.
export function selectionRedisLinks(
  links: LinkRecord[],
  connId: string,
  key: string,
  field?: string
): LinkRecord[] {
  return links.filter(
    (link) =>
      isRedisSource(link, connId, key) &&
      link.source_extract === 'selection' &&
      (!link.source_field || link.source_field === field)
  )
}

/**
 * Every link this connection takes part in, as source or as target.
 *
 * The other filters here answer "what can I click from the thing on screen",
 * which is why a key, table or topic with no links of its own showed an empty
 * menu -- indistinguishable from a connection that has none configured at all.
 * This answers the other question, "what is wired up on this connection",
 * so the menu can say so instead of going blank.
 *
 * `exclude` drops links a menu is already showing as actionable, so the group
 * adds information rather than repeating the list above it.
 */
export function connectionLinks(
  links: LinkRecord[],
  connId: string,
  exclude: LinkRecord[] = []
): LinkRecord[] {
  const shown = new Set(exclude.map((link) => link.id))
  return links.filter(
    (link) =>
      !shown.has(link.id) && (link.source_conn_id === connId || link.target_conn_id === connId)
  )
}

// linkSummary renders a readable one-line description of a link for the Settings list.
export function linkSummary(link: LinkRecord): string {
  const srcDetail = link.source_extract
    ? ` [${link.source_extract}${link.source_field ? ` ${link.source_field}` : ''}]`
    : link.source_field
    ? ` ${link.source_field}`
    : ''
  const source = `${link.source_kind}:${link.source_scope}${srcDetail}`
  let target: string
  if (link.target_kind === 'kafka') {
    target = `kafka:${link.target_topic} (${link.target_field})`
  } else if (link.target_kind === 'redis') {
    target = `redis:${link.key_pattern}`
  } else {
    target = `postgres:${link.table}.${link.column}`
  }
  return `${source} → ${target}`
}
