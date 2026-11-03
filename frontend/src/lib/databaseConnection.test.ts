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

const billing = databaseConnectionId('pg-1', 'billing')

describe('findConnection', () => {
  it.each([
    ['stored id', 'pg-1', 'orders', 'orders dev'],
    ['runtime database', databaseConnectionId('pg-1', 'billing'), 'billing', 'orders dev · billing'],
    ['URL and separator characters', databaseConnectionId('pg-1', 'a/b?c#d~e %f'), 'a/b?c#d~e %f', 'orders dev · a/b?c#d~e %f'],
    ['non-ASCII name', databaseConnectionId('pg-1', 'счета'), 'счета', 'orders dev · счета'],
  ])('%s', (_, id, database, name) => {
    const found = findConnection([pg, redis], id)
    expect(found).toMatchObject({ id, database, name, username: 'app' })
  })

  it('keeps the id URL-safe', () => {
    expect(databaseConnectionId('pg-1', 'a/b?c#d~e %f')).toMatch(/^pg-1~[A-Za-z0-9_-]+$/)
  })

  it('never nests a runtime id inside another', () => {
    expect(databaseConnectionId(databaseConnectionId('pg-1', 'billing'), 'other')).toBe(databaseConnectionId('pg-1', 'other'))
  })

  it.each([['pg-1~'], ['pg-1~!!'], [databaseConnectionId('pg-9', 'billing')], [databaseConnectionId('redis-1', 'billing')], [''], [null]])(
    'does not resolve %s',
    (id) => {
      expect(findConnection([pg, redis], id)).toBeUndefined()
    }
  )

  it('drops the parent schema filter, it names schemas of another database', () => {
    expect(findConnection([pg], billing)?.visible_schemas).toBeNull()
  })

  it('returns the same object for the same parent, so selectors do not re-render forever', () => {
    expect(findConnection([pg], billing)).toBe(findConnection([pg], billing))
  })

  it('derives afresh once the parent is refetched', () => {
    const before = findConnection([pg], billing)
    const after = findConnection([{ ...pg, username: 'rotated' }], billing)
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
