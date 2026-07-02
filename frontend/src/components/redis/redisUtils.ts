import type { ColumnMeta, ObjectType, RedisObjectType, TableRow } from '@/types/api'

const REDIS_TYPE_LABELS: Record<string, string> = {
  redis_string: 'String',
  redis_hash: 'Hash',
  redis_list: 'List',
  redis_set: 'Set',
  redis_zset: 'Sorted Set',
  redis_stream: 'Stream',
  redis_json: 'JSON',
  namespace: 'Namespace',
}

const REDIS_TYPE_CLASSES: Record<string, string> = {
  redis_string: 'border-red-500/20 bg-red-500/10 text-red-600 dark:text-red-400',
  redis_hash: 'border-emerald-500/20 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
  redis_list: 'border-sky-500/20 bg-sky-500/10 text-sky-600 dark:text-sky-400',
  redis_set: 'border-violet-500/20 bg-violet-500/10 text-violet-600 dark:text-violet-400',
  redis_zset: 'border-amber-500/20 bg-amber-500/10 text-amber-600 dark:text-amber-400',
  redis_stream: 'border-orange-500/20 bg-orange-500/10 text-orange-600 dark:text-orange-400',
  redis_json: 'border-cyan-500/20 bg-cyan-500/10 text-cyan-600 dark:text-cyan-400',
  namespace: 'border-red-500/20 bg-red-500/10 text-red-600 dark:text-red-400',
  default: 'border-border bg-muted/40 text-muted-foreground',
}

export function getRedisObjectTypeLabel(type: ObjectType | string | undefined): string {
  if (!type) return 'Key'
  return REDIS_TYPE_LABELS[type] ?? String(type)
}

export function getRedisTypePillClass(type: ObjectType | string | undefined): string {
  if (!type) return REDIS_TYPE_CLASSES.default
  return REDIS_TYPE_CLASSES[type] ?? REDIS_TYPE_CLASSES.default
}

export function formatRedisTTL(ttlSeconds?: number | null): string | null {
  if (ttlSeconds === undefined || ttlSeconds === null || ttlSeconds === -2) {
    return null
  }
  if (ttlSeconds === -1) {
    return 'No TTL'
  }

  const seconds = Math.max(0, Math.floor(ttlSeconds))
  if (seconds >= 86400) {
    const days = Math.floor(seconds / 86400)
    const hours = Math.floor((seconds % 86400) / 3600)
    return hours > 0 ? `${days}d ${hours}h` : `${days}d`
  }
  if (seconds >= 3600) {
    const hours = Math.floor(seconds / 3600)
    const minutes = Math.floor((seconds % 3600) / 60)
    return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`
  }
  if (seconds >= 60) {
    const minutes = Math.floor(seconds / 60)
    const remaining = seconds % 60
    return remaining > 0 ? `${minutes}m ${remaining}s` : `${minutes}m`
  }
  return `${seconds}s`
}

export function getRedisTTLStyle(ttlSeconds?: number | null): string {
  if (ttlSeconds === undefined || ttlSeconds === null || ttlSeconds === -2) {
    return 'border-border bg-muted/40 text-muted-foreground'
  }
  if (ttlSeconds === -1) {
    return 'border-border bg-muted/40 text-muted-foreground'
  }
  if (ttlSeconds < 300) {
    return 'border-red-500/20 bg-red-500/10 text-red-600 dark:text-red-400'
  }
  if (ttlSeconds < 3600) {
    return 'border-amber-500/20 bg-amber-500/10 text-amber-600 dark:text-amber-400'
  }
  return 'border-emerald-500/20 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
}

export function createRedisColumn(
  name: string,
  dataType: string,
  editable: boolean,
  nullable = false
): ColumnMeta {
  return {
    name,
    data_type: dataType,
    nullable,
    default: null,
    is_pk: false,
    is_fk: false,
    fk_table: '',
    fk_column: '',
    editable,
  }
}

export function getRedisRowKey(row: TableRow, preferredFields: string[], fallbackIndex: number): string {
  for (const field of preferredFields) {
    const value = row[field]
    if (value !== null && value !== undefined && String(value).trim() !== '') {
      return String(value)
    }
  }
  return `redis-row:${fallbackIndex}`
}

export function tryParseJson(value: string): { isJson: boolean; text: string; parsed?: unknown } {
  const trimmed = value.trim()
  if (trimmed === '') {
    return { isJson: false, text: value }
  }

  try {
    const parsed = JSON.parse(trimmed)
    return {
      isJson: true,
      parsed,
      text: JSON.stringify(parsed, null, 2),
    }
  } catch {
    return { isJson: false, text: value }
  }
}

export function stringifyRedisValue(value: unknown): string {
  if (value === null || value === undefined) {
    return ''
  }
  if (typeof value === 'string') {
    return value
  }
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value)
  }
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

export function toNumberOrNull(value: string): number | null {
  if (value.trim() === '') {
    return null
  }
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

export function normalizeRedisObjectType(type: ObjectType | string | undefined): RedisObjectType | 'namespace' | 'unsupported' {
  if (type === 'namespace') {
    return 'namespace'
  }
  if (
    type === 'redis_string' ||
    type === 'redis_hash' ||
    type === 'redis_list' ||
    type === 'redis_set' ||
    type === 'redis_zset' ||
    type === 'redis_stream' ||
    type === 'redis_json'
  ) {
    return type
  }
  return 'unsupported'
}
