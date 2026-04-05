export type PostgresTypeCategory = 'numeric' | 'text' | 'boolean' | 'temporal' | 'uuid' | 'json' | 'other'

export interface PostgresTypeBadge {
  category: PostgresTypeCategory
  label: string
  className: string
  title: string
}

const TYPE_CLASS_BY_CATEGORY: Record<PostgresTypeCategory, string> = {
  numeric: 'border-cyan-500/30 bg-cyan-500/10 text-cyan-600 dark:text-cyan-400',
  text: 'border-green-500/30 bg-green-500/10 text-green-600 dark:text-green-400',
  boolean: 'border-purple-500/30 bg-purple-500/10 text-purple-600 dark:text-purple-400',
  temporal: 'border-orange-500/30 bg-orange-500/10 text-orange-600 dark:text-orange-400',
  uuid: 'border-pink-500/30 bg-pink-500/10 text-pink-600 dark:text-pink-400',
  json: 'border-yellow-500/30 bg-yellow-500/10 text-yellow-600 dark:text-yellow-400',
  other: 'border-gray-500/30 bg-gray-500/10 text-gray-600 dark:text-gray-400',
}

const TYPE_ALIASES: Record<string, string> = {
  'character varying': 'varchar',
  'character': 'char',
  'timestamp without time zone': 'timestamp',
  'timestamp with time zone': 'timestamptz',
  'time without time zone': 'time',
  'time with time zone': 'timetz',
  'double precision': 'float8',
  real: 'float4',
  smallint: 'int2',
  integer: 'int4',
  bigint: 'int8',
}

function normalizeTypeName(dataType: string): string {
  const lower = dataType.toLowerCase().trim()
  return TYPE_ALIASES[lower] ?? lower
}

export function getPostgresTypeCategory(dataType: string): PostgresTypeCategory {
  const lower = normalizeTypeName(dataType)
  if (['int2', 'int4', 'int8', 'numeric', 'float4', 'float8', 'decimal'].includes(lower)) return 'numeric'
  if (['varchar', 'text', 'char', 'bpchar', 'name'].includes(lower)) return 'text'
  if (['bool', 'boolean'].includes(lower)) return 'boolean'
  if (['timestamp', 'timestamptz', 'date', 'time', 'timetz'].includes(lower)) return 'temporal'
  if (lower === 'uuid') return 'uuid'
  if (['json', 'jsonb'].includes(lower)) return 'json'
  return 'other'
}

export function getPostgresTypeBadge(dataType: string): PostgresTypeBadge {
  const normalized = normalizeTypeName(dataType)
  const category = getPostgresTypeCategory(normalized)
  const labelMap: Partial<Record<PostgresTypeCategory, string>> = {
    numeric: normalized,
    text: normalized,
    boolean: 'bool',
    temporal: normalized,
    uuid: 'uuid',
    json: normalized,
    other: normalized || 'unknown',
  }

  const label = labelMap[category] ?? normalized

  return {
    category,
    label: label.length > 14 ? `${label.slice(0, 13)}…` : label,
    className: TYPE_CLASS_BY_CATEGORY[category],
    title: dataType,
  }
}
