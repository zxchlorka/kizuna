import { describe, expect, it } from 'vitest'
import {
  availableStatements,
  buildRowStatement,
  completePrimaryKey,
  quoteQualifiedName,
  sqlLiteral,
} from '@/lib/rowSql'
import type { ColumnMeta } from '@/types/api'

function column(name: string, overrides: Partial<ColumnMeta> = {}): ColumnMeta {
  return {
    name,
    data_type: 'text',
    nullable: true,
    default: null,
    is_pk: false,
    is_fk: false,
    fk_table: '',
    fk_column: '',
    ...overrides,
  }
}

const keyed = [column('id', { data_type: 'int4', is_pk: true }), column('name'), column('note')]
const row = { id: 42, name: "O'Brien", note: null }

describe('identifiers and literals', () => {
  it('quotes both halves of a qualified name', () => {
    expect(quoteQualifiedName('public.users')).toBe('"public"."users"')
    expect(quoteQualifiedName('users')).toBe('"users"')
    expect(quoteQualifiedName('public.order.items')).toBe('"public"."order.items"')
  })

  it('survives a quote inside an identifier', () => {
    expect(quoteQualifiedName('we"ird')).toBe('"we""ird"')
  })

  it('escapes a quote inside a string rather than ending the literal', () => {
    expect(sqlLiteral("O'Brien")).toBe("'O''Brien'")
    expect(sqlLiteral("'; DROP TABLE users; --")).toBe("'''; DROP TABLE users; --'")
  })

  it('writes the other types the way Postgres reads them', () => {
    expect(sqlLiteral(null)).toBe('NULL')
    expect(sqlLiteral(undefined)).toBe('NULL')
    expect(sqlLiteral(42)).toBe('42')
    expect(sqlLiteral(-1.5)).toBe('-1.5')
    expect(sqlLiteral(true)).toBe('TRUE')
    expect(sqlLiteral(false)).toBe('FALSE')
    expect(sqlLiteral({ a: 1 })).toBe(`'{"a":1}'`)
    expect(sqlLiteral(['x', "y'z"])).toBe(`'["x","y''z"]'`)
  })
})

describe('with a primary key', () => {
  it('offers every statement', () => {
    expect(availableStatements(keyed, row)).toEqual(['select', 'insert', 'update', 'delete'])
  })

  it('selects on the key alone', () => {
    expect(buildRowStatement('select', 'public.users', keyed, row)).toBe(
      'SELECT *\nFROM "public"."users"\nWHERE "id" = 42;'
    )
  })

  it('deletes on the key alone', () => {
    expect(buildRowStatement('delete', 'public.users', keyed, row)).toBe(
      'DELETE FROM "public"."users"\nWHERE "id" = 42;'
    )
  })

  it('inserts every column it has', () => {
    expect(buildRowStatement('insert', 'public.users', keyed, row)).toBe(
      'INSERT INTO "public"."users" ("id", "name", "note")\nVALUES (42, \'O\'\'Brien\', NULL);'
    )
  })

  it('updates the non-key columns and keys the WHERE', () => {
    expect(buildRowStatement('update', 'public.users', keyed, row)).toBe(
      'UPDATE "public"."users"\nSET "name" = \'O\'\'Brien\',\n    "note" = NULL\nWHERE "id" = 42;'
    )
  })

  it('keys on every column of a composite key', () => {
    const columns = [
      column('tenant', { is_pk: true }),
      column('id', { is_pk: true }),
      column('name'),
    ]
    expect(buildRowStatement('delete', 'orders', columns, { tenant: 'acme', id: 7, name: 'x' })).toBe(
      'DELETE FROM "orders"\nWHERE "tenant" = \'acme\'\n  AND "id" = 7;'
    )
  })
})

describe('without a usable primary key', () => {
  const unkeyed = [column('name'), column('note')]

  it('refuses to write UPDATE or DELETE', () => {
    expect(buildRowStatement('delete', 'logs', unkeyed, { name: 'a', note: 'b' })).toBeNull()
    expect(buildRowStatement('update', 'logs', unkeyed, { name: 'a', note: 'b' })).toBeNull()
    expect(availableStatements(unkeyed, { name: 'a' })).toEqual(['select', 'insert'])
  })

  it('counts a key whose value is missing as no key at all', () => {
    const columns = [column('id', { is_pk: true }), column('name')]
    expect(completePrimaryKey(columns, { id: null, name: 'x' })).toBeNull()
    expect(buildRowStatement('delete', 'users', columns, { id: null, name: 'x' })).toBeNull()
  })

  it('needs every column of a composite key present', () => {
    const columns = [column('tenant', { is_pk: true }), column('id', { is_pk: true })]
    expect(completePrimaryKey(columns, { tenant: 'acme', id: null })).toBeNull()
  })

  it('still selects, matching on all columns with NULL handled', () => {
    expect(buildRowStatement('select', 'logs', unkeyed, { name: 'a', note: null })).toBe(
      'SELECT *\nFROM "logs"\nWHERE "name" = \'a\'\n  AND "note" IS NULL;'
    )
  })
})

describe('a row the grid only partly loaded', () => {
  it('never claims a column the row does not carry', () => {
    const statement = buildRowStatement('insert', 'users', keyed, { id: 1 })
    expect(statement).toBe('INSERT INTO "users" ("id")\nVALUES (1);')
  })

  it('has nothing to update when only the key is present', () => {
    expect(buildRowStatement('update', 'users', keyed, { id: 1 })).toBeNull()
  })
})
