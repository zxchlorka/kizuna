import { describe, expect, it } from 'vitest'
import { draftCellValue, type DraftUpdateState } from '@/lib/table-drafts'

const drafts: Record<string, DraftUpdateState> = {
  'id:1': { where: { id: 1 }, data: { name: 'Alice Smith' } },
}

describe('draftCellValue', () => {
  it('returns the unsaved draft for a cell that has one', () => {
    expect(draftCellValue(drafts, 'id:1', 'name', 'Alice')).toBe('Alice Smith')
  })

  it('falls back to the stored value for an untouched cell of an edited row', () => {
    expect(draftCellValue(drafts, 'id:1', 'email', 'a@example.com')).toBe('a@example.com')
  })

  it('falls back to the stored value for a row with no drafts', () => {
    expect(draftCellValue(drafts, 'id:2', 'name', 'Bob')).toBe('Bob')
  })

  it('returns the stored value when the row has no key (table without a primary key)', () => {
    expect(draftCellValue(drafts, undefined, 'name', 'Alice')).toBe('Alice')
  })

  // A draft that blanks a cell is still a draft. A truthiness check here would
  // silently serve the old value for exactly the edit most worth getting right.
  it('honours a draft that sets the cell to an empty or null value', () => {
    const blanked: Record<string, DraftUpdateState> = {
      'id:1': { where: { id: 1 }, data: { name: '', note: null, flag: undefined } },
    }
    expect(draftCellValue(blanked, 'id:1', 'name', 'Alice')).toBe('')
    expect(draftCellValue(blanked, 'id:1', 'note', 'old note')).toBeNull()
    expect(draftCellValue(blanked, 'id:1', 'flag', true)).toBeUndefined()
  })

  it('does not treat an inherited property name as a draft', () => {
    expect(draftCellValue(drafts, 'id:1', 'toString', 'stored')).toBe('stored')
  })
})
