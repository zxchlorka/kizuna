import { describe, expect, it } from 'vitest'
import { databaseConnectionId, findConnection, parentConnectionId } from './databaseConnection'
import type { Connection } from '@/types/api'

const pg = {
  id: 'pg-1',
  name: 'orders dev',
  type: 'postgres',
  database: 'orders',
  username: 'app',
  visible_schemas: ['public'],
} as Connection
const redis = { id: 'redis-1', name: 'cache', type: 'redis', visible_schemas: null } as Connection

describe('findConnection', () => {
  it.each([
    ['stored id', 'pg-1', 'orders', 'orders dev'],
    ['runtime database', 'pg-1~billing', 'billing', 'orders dev · billing'],
    ['separator inside the database name', 'pg-1~a~b', 'a~b', 'orders dev · a~b'],
  ])('%s', (_, id, database, name) => {
    const found = findConnection([pg, redis], id)
    expect(found).toMatchObject({ id, database, name, username: 'app' })
  })

  it.each([['pg-1~'], ['pg-9~billing'], ['redis-1~billing'], [''], [null]])('does not resolve %s', (id) => {
    expect(findConnection([pg, redis], id)).toBeUndefined()
  })

  it('drops the parent schema filter, it names schemas of another database', () => {
    expect(findConnection([pg], 'pg-1~billing')?.visible_schemas).toBeNull()
  })

  it('returns the same object for the same parent, so selectors do not re-render forever', () => {
    expect(findConnection([pg], 'pg-1~billing')).toBe(findConnection([pg], 'pg-1~billing'))
  })

  it('derives afresh once the parent is refetched', () => {
    const before = findConnection([pg], 'pg-1~billing')
    const after = findConnection([{ ...pg, username: 'rotated' }], 'pg-1~billing')
    expect(after).not.toBe(before)
    expect(after?.username).toBe('rotated')
  })
})

describe('connection ids', () => {
  it('round-trips the parent id', () => {
    expect(parentConnectionId(databaseConnectionId('pg-1', 'a~b'))).toBe('pg-1')
    expect(parentConnectionId('pg-1')).toBe('pg-1')
  })
})
