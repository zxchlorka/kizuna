import type { ColumnMeta, TableRow } from '@/types/api'

/**
 * Statements for one row, to paste into a console, a ticket or a runbook.
 *
 * Editing a row in the grid changes it and leaves nothing behind; what gets
 * pasted into an incident channel or a migration is the statement. So the
 * statement is what this produces.
 *
 * The safety rule is UPDATE and DELETE: both are generated only against a
 * complete primary key. A statement that says WHERE over ordinary columns looks
 * just as precise and can match rows nobody looked at, which is the one mistake
 * this feature could hand someone.
 */

export type RowStatementKind = 'select' | 'insert' | 'update' | 'delete'

// Postgres identifier: always double-quoted, so a name that is a keyword, is
// mixed case, or contains punctuation survives. A quote inside a name doubles.
function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`
}

// "public.users" is two identifiers, not one. A dotted name is split on the
// first dot only — a schema cannot contain one, a table can.
export function quoteQualifiedName(object: string): string {
  const dot = object.indexOf('.')
  if (dot <= 0) {
    return quoteIdent(object)
  }
  return `${quoteIdent(object.slice(0, dot))}.${quoteIdent(object.slice(dot + 1))}`
}

/**
 * A value as a SQL literal.
 *
 * Strings are single-quoted with doubled quotes inside, which is what makes the
 * output safe to paste. jsonb and arrays arrive as objects and are written as
 * their JSON text — Postgres casts the literal on the way into a typed column.
 * Numbers and booleans are written bare so they do not need one.
 */
export function sqlLiteral(value: unknown): string {
  if (value === null || value === undefined) {
    return 'NULL'
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? String(value) : `'${value}'`
  }
  if (typeof value === 'boolean') {
    return value ? 'TRUE' : 'FALSE'
  }
  const text = typeof value === 'object' ? JSON.stringify(value) : String(value)
  return `'${text.replace(/'/g, "''")}'`
}

function predicate(column: string, value: unknown): string {
  if (value === null || value === undefined) {
    return `${quoteIdent(column)} IS NULL`
  }
  return `${quoteIdent(column)} = ${sqlLiteral(value)}`
}

/**
 * The primary key columns, but only when the row carries a value for every one
 * of them. A partial key identifies nothing, so it counts as no key at all.
 */
export function completePrimaryKey(columns: ColumnMeta[], row: TableRow): ColumnMeta[] | null {
  const pk = columns.filter((column) => column.is_pk)
  if (pk.length === 0) {
    return null
  }
  const complete = pk.every((column) => row[column.name] !== null && row[column.name] !== undefined)
  return complete ? pk : null
}

/** Which statements can be written for this row. */
export function availableStatements(columns: ColumnMeta[], row: TableRow): RowStatementKind[] {
  return completePrimaryKey(columns, row) !== null
    ? ['select', 'insert', 'update', 'delete']
    : ['select', 'insert']
}

/**
 * Builds one statement, or null when this row cannot support it.
 *
 * Without a primary key SELECT still works — it matches on every column, which
 * is imprecise but harmless — while UPDATE and DELETE are refused outright.
 */
export function buildRowStatement(
  kind: RowStatementKind,
  object: string,
  columns: ColumnMeta[],
  row: TableRow
): string | null {
  const table = quoteQualifiedName(object)
  const pk = completePrimaryKey(columns, row)

  if ((kind === 'update' || kind === 'delete') && pk === null) {
    return null
  }

  // Only the columns the row actually carries; a projection the grid narrowed
  // must not turn into a statement claiming values it never saw.
  const present = columns.filter((column) => column.name in row)
  if (present.length === 0) {
    return null
  }

  const where = (pk ?? present).map((column) => predicate(column.name, row[column.name])).join('\n  AND ')

  switch (kind) {
    case 'select':
      return `SELECT *\nFROM ${table}\nWHERE ${where};`
    case 'delete':
      return `DELETE FROM ${table}\nWHERE ${where};`
    case 'insert': {
      const names = present.map((column) => quoteIdent(column.name)).join(', ')
      const values = present.map((column) => sqlLiteral(row[column.name])).join(', ')
      return `INSERT INTO ${table} (${names})\nVALUES (${values});`
    }
    case 'update': {
      // The key identifies the row; setting it again says nothing and would
      // quietly move the row if the value were edited afterwards.
      const keyNames = new Set((pk ?? []).map((column) => column.name))
      const assignments = present
        .filter((column) => !keyNames.has(column.name))
        .map((column) => `${quoteIdent(column.name)} = ${sqlLiteral(row[column.name])}`)
      if (assignments.length === 0) {
        return null
      }
      return `UPDATE ${table}\nSET ${assignments.join(',\n    ')}\nWHERE ${where};`
    }
  }
}
