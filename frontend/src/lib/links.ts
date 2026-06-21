import type { ColumnMeta, LinkRecord, TableRow } from '@/types/api'

// extractMessageField parses a Kafka message JSON value and returns the scalar
// at a dot-path (e.g. "user_id", "user.id"). Returns null when the value is not
// JSON, the path is missing, or the leaf is not a scalar.
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
  let current: unknown = parsed
  for (const part of field.split('.')) {
    if (typeof current !== 'object' || current === null || Array.isArray(current)) {
      return null
    }
    current = (current as Record<string, unknown>)[part]
    if (current === undefined) {
      return null
    }
  }
  if (current === null || typeof current === 'object') {
    return null
  }
  return String(current)
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
