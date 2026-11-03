import { describe, expect, it } from 'vitest'
import { buildPaletteEntries, mergeNamespaces, searchPalette, topNamespaces } from './commandPalette'
import { databaseConnectionId } from './databaseConnection'
import type { Connection, ObjectItem } from '@/types/api'

const connections = [
  { id: 'pg1', name: 'stage-pg', type: 'postgres' },
  { id: 'pg2', name: 'local-pg', type: 'postgres' },
  { id: 'k1', name: 'stage-kafka', type: 'kafka' },
] as Connection[]

const item = (type: string, name: string, extra: Partial<ObjectItem> = {}) =>
  ({ type, name, schema: 'public', row_count: 0, ...extra }) as ObjectItem

const treeItems: Record<string, ObjectItem[]> = {
  'pg1::': [item('schema', 'public')],
  'pg1::public': [item('table', 'orders'), item('table', 'order_items'), item('view', 'big_orders'), item('index', 'orders_pkey')],
  'pg2::public': [item('table', 'orders')],
  'k1::': [item('kafka_topic', 'orders.events', { schema: '', path: 'orders.events' })],
  'gone::public': [item('table', 'orphan')],
}

describe('command palette', () => {
  const entries = buildPaletteEntries(connections, treeItems)
  const labels = (query: string) => searchPalette(entries, query).map((e) => `${e.connName} ${e.object ?? ''}`.trim())

  it('indexes connections plus loaded tables, views and topics, skipping indexes and unknown connections', () => {
    expect(entries.map((e) => e.object ?? e.connName)).toEqual([
      'stage-pg',
      'local-pg',
      'stage-kafka',
      'public.orders',
      'public.order_items',
      'public.big_orders',
      'public.orders',
      'orders.events',
    ])
  })

  it('shows only connections before anything is typed', () => {
    expect(labels('')).toEqual(['stage-pg', 'local-pg', 'stage-kafka'])
  })

  it('ranks a name prefix above a substring and a shorter name first', () => {
    expect(labels('ord')).toEqual([
      'local-pg public.orders',
      'stage-pg public.orders',
      'stage-pg public.order_items',
      'stage-kafka orders.events',
      'stage-pg public.big_orders',
    ])
  })

  it('needs every word to match, so a second word narrows by connection', () => {
    expect(labels('orders local')).toEqual(['local-pg public.orders'])
  })
})

describe('remembered Redis namespaces', () => {
  const redis = [{ id: 'r1', name: 'stage redis', type: 'redis', separator: '/' }] as Connection[]

  it('takes the first segment of keys that have one', () => {
    const keys = ['nms/1/a', 'nms/2', 'user/9', 'plain', '/leading'].map((name) => item('string', name))
    expect(topNamespaces(keys, '/').sort()).toEqual(['nms', 'user'])
  })

  it('accumulates across visits instead of forgetting what a filtered tree did not show', () => {
    expect(mergeNamespaces(['user', 'nms'], ['fp', 'nms'])).toEqual(['fp', 'nms', 'user'])
  })

  it('offers a namespace as a pattern in the connection separator', () => {
    const entries = buildPaletteEntries(redis, {}, { r1: ['nms'], gone: ['x'] })
    expect(searchPalette(entries, 'nms').map((e) => [e.object, e.objectType])).toEqual([['nms/*', 'namespace']])
  })
})

describe('runtime databases', () => {
  it('lists tables of an opened runtime database under its derived name', () => {
    const runtime = databaseConnectionId('pg1', 'billing')
    const entries = buildPaletteEntries(connections, { [`${runtime}::public`]: [item('table', 'invoices')] })
    expect(entries.find((e) => e.object === 'public.invoices')).toMatchObject({ connId: runtime, connName: 'stage-pg · billing' })
  })
})

describe('folder paths', () => {
  const folders = [
    { id: 'team', name: 'Billing' },
    { id: 'env', name: 'Envs', parent_id: 'team' },
  ]
  const inFolders = [
    { id: 'a', name: 'prod', type: 'postgres', folder_id: 'env' },
    { id: 'b', name: 'prod', type: 'postgres' },
  ] as Connection[]
  const entries = buildPaletteEntries(inFolders, { 'a::public': [item('table', 'invoices')] }, {}, folders)

  it('carries the full path on the connection and on its objects', () => {
    expect(entries.map((e) => e.folderPath)).toEqual(['Billing / Envs', '', 'Billing / Envs'])
  })

  it('narrows by folder name: the prod outside Billing drops out', () => {
    expect(searchPalette(entries, 'billing prod').map((e) => e.id)).toEqual(['a', 'a::public.invoices'])
    expect(searchPalette(entries, 'billing invoices').map((e) => e.id)).toEqual(['a::public.invoices'])
  })

  it('puts a runtime database in its parent folder', () => {
    const runtime = databaseConnectionId('a', 'archive')
    const withRuntime = buildPaletteEntries(inFolders, { [`${runtime}::public`]: [item('table', 'old')] }, {}, folders)
    expect(withRuntime.find((e) => e.connId === runtime)?.folderPath).toBe('Billing / Envs')
  })
})
