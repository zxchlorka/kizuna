import type { ColumnMeta, DataResult, FilterExpr, TableRow } from '@/types/api'
import type { ColumnFilterState, RowIdentity } from '@/types/table'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const INTEGER_TYPES = new Set(['int2', 'int4', 'int8', 'integer', 'bigint'])
const NUMERIC_TYPES = new Set(['numeric', 'float4', 'float8', 'decimal'])
const BOOL_TYPES = new Set(['bool', 'boolean'])
const UUID_TYPES = new Set(['uuid'])
const TIMESTAMP_TYPES = new Set(['timestamp', 'timestamptz', 'date', 'time', 'timetz'])

export const VALUELESS_FILTER_OPS = new Set<FilterExpr['op']>(['is_null', 'is_not_null'])

export function normalizeUUIDString(value: string): string | null {
  const trimmed = value.trim()
  if (UUID_RE.test(trimmed)) {
    return trimmed.toLowerCase()
  }
  return null
}

export function normalizeRowValue(value: unknown, column: ColumnMeta): unknown {
  if (typeof value !== 'string') {
    return value
  }

  if (column.data_type.toLowerCase() === 'uuid') {
    return normalizeUUIDString(value) ?? value
  }

  return value
}

export function normalizeDataRows(result: Pick<DataResult, 'rows' | 'columns'>): TableRow[] {
  if (!result.rows || result.rows.length === 0) {
    return result.rows ?? []
  }

  return result.rows.map((row) => {
    const normalized: TableRow = {}
    result.columns.forEach((column) => {
      normalized[column.name] = normalizeRowValue(row[column.name], column)
    })
    return normalized
  })
}

export function defaultFilterOp(dataType: string): FilterExpr['op'] {
  const dt = dataType.toLowerCase()
  if (INTEGER_TYPES.has(dt) || NUMERIC_TYPES.has(dt) || TIMESTAMP_TYPES.has(dt) || UUID_TYPES.has(dt) || BOOL_TYPES.has(dt)) {
    return 'eq'
  }
  return 'contains'
}

export function filtersToState(columns: ColumnMeta[], filters: FilterExpr[]): Record<string, ColumnFilterState> {
  const out: Record<string, ColumnFilterState> = {}
  columns.forEach((column) => {
    out[column.name] = { op: defaultFilterOp(column.data_type), value: '' }
  })
  filters.forEach((filter) => {
    out[filter.column] = {
      op: filter.op,
      value: VALUELESS_FILTER_OPS.has(filter.op) ? '' : filter.value,
    }
  })
  return out
}

export function normalizeFilters(filters: FilterExpr[]): FilterExpr[] {
  return [...filters]
    .map((filter) => ({
      column: filter.column,
      op: filter.op,
      value: VALUELESS_FILTER_OPS.has(filter.op) ? '' : filter.value.trim(),
    }))
    .filter((filter) => VALUELESS_FILTER_OPS.has(filter.op) || filter.value !== '')
    .sort((left, right) => {
      if (left.column !== right.column) return left.column.localeCompare(right.column)
      if (left.op !== right.op) return left.op.localeCompare(right.op)
      return left.value.localeCompare(right.value)
    })
}

export function filtersEqual(left: FilterExpr[], right: FilterExpr[]): boolean {
  const normalizedLeft = normalizeFilters(left)
  const normalizedRight = normalizeFilters(right)
  if (normalizedLeft.length !== normalizedRight.length) return false

  return normalizedLeft.every((filter, index) => {
    const next = normalizedRight[index]
    return filter.column === next.column && filter.op === next.op && filter.value === next.value
  })
}

export function stableWhereKey(where: Record<string, unknown>): string {
  const keys = Object.keys(where).sort()
  return keys.map((key) => `${key}=${JSON.stringify(where[key])}`).join('|')
}

export function buildPkWhere(columns: ColumnMeta[], row: TableRow): Record<string, unknown> | null {
  const pkColumns = columns.filter((column) => column.is_pk)
  if (pkColumns.length === 0) {
    return null
  }

  const where: Record<string, unknown> = {}
  for (const column of pkColumns) {
    const value = row[column.name]
    if (value === null || value === undefined) {
      return null
    }
    where[column.name] = value
  }

  return where
}

export function buildRowIdentity(columns: ColumnMeta[], row: TableRow): RowIdentity | null {
  const where = buildPkWhere(columns, row)
  if (!where) {
    return null
  }

  return {
    rowKey: stableWhereKey(where),
    where,
  }
}
