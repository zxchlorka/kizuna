import { describe, expect, it } from 'vitest'
import { resolveSelectedRows } from '@/lib/table'
import type { TableRow } from '@/types/api'

function selection(entries: [string, TableRow][]): Map<string, { row: TableRow }> {
  return new Map(entries.map(([rowKey, row]) => [rowKey, { row }]))
}

// Copy/export must reproduce what the grid is showing. A selection outlives a
// Refresh, so the row captured when the box was ticked can describe values that
// are no longer on screen -- and copying those is silent, plausible-looking
// wrong data on the user's clipboard.
describe('resolveSelectedRows', () => {
  it('prefers the loaded page over the snapshot taken at selection time', () => {
    const selected = selection([['pk:1', { id: 1, status: 'pending' }]])
    const loaded = new Map<string, TableRow>([['pk:1', { id: 1, status: 'shipped' }]])

    const resolved = resolveSelectedRows(selected, (key) => loaded.get(key))

    expect(resolved).toEqual([{ rowKey: 'pk:1', row: { id: 1, status: 'shipped' } }])
  })

  it('keeps the snapshot for rows checked on a page that is no longer loaded', () => {
    const selected = selection([
      ['pk:1', { id: 1, status: 'pending' }],
      ['pk:99', { id: 99, status: 'archived' }],
    ])
    // Only pk:1 is on the current page; pk:99 was checked two pages back.
    const loaded = new Map<string, TableRow>([['pk:1', { id: 1, status: 'shipped' }]])

    const resolved = resolveSelectedRows(selected, (key) => loaded.get(key))

    expect(resolved).toEqual([
      { rowKey: 'pk:1', row: { id: 1, status: 'shipped' } },
      { rowKey: 'pk:99', row: { id: 99, status: 'archived' } },
    ])
  })

  it('returns one entry per selected row, in the order they were checked', () => {
    const selected = selection([
      ['pk:3', { id: 3 }],
      ['pk:1', { id: 1 }],
      ['pk:2', { id: 2 }],
    ])

    const resolved = resolveSelectedRows(selected, () => undefined)

    expect(resolved.map((entry) => entry.rowKey)).toEqual(['pk:3', 'pk:1', 'pk:2'])
    expect(resolved).toHaveLength(selected.size)
  })
})
