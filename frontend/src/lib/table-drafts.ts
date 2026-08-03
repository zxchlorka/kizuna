import type { BulkMutateOp, MutateOp } from '@/types/api'

export interface DraftUpdateState {
  where: Record<string, unknown>
  data: Record<string, unknown>
}

export interface DraftDeleteState {
  where: Record<string, unknown>
}

/**
 * The value a cell currently HAS from the user's point of view: the unsaved
 * draft if one was typed, otherwise what was fetched.
 *
 * Single source of that rule. It used to live only in the cell renderer, so
 * everything else -- copy cell, copy row, copy selected, CSV/JSON export --
 * silently served the pre-edit value for a cell the user had just changed, while
 * the screen right next to it showed the new one.
 *
 * `rowKey` is optional because a row can arrive without one (a table with no
 * primary key has no stable identity, so it can carry no drafts either); in that
 * case the stored value is all there is.
 */
export function draftCellValue(
  draftUpdates: Record<string, DraftUpdateState>,
  rowKey: string | undefined,
  columnName: string,
  fallback: unknown
): unknown {
  if (rowKey === undefined) {
    return fallback
  }
  const rowDraft = draftUpdates[rowKey]
  // Presence rather than truthiness: a draft that sets a cell to null, undefined
  // or '' is still a draft and must win over the stored value.
  //
  // hasOwnProperty rather than `in`: `in` walks the prototype chain, so a column
  // named toString/constructor/valueOf reported a draft on every row and handed
  // back an Object.prototype member instead of the cell's value.
  if (!rowDraft || !Object.prototype.hasOwnProperty.call(rowDraft.data, columnName)) {
    return fallback
  }
  return rowDraft.data[columnName]
}

export function buildBulkMutatePayload(
  schema: string,
  object: string,
  draftUpdates: Record<string, DraftUpdateState>,
  draftDeletes: Record<string, DraftDeleteState>,
  draftInserts: Record<string, unknown>[]
): BulkMutateOp {
  const operations: MutateOp[] = []

  Object.entries(draftUpdates).forEach(([rowKey, draft]) => {
    if (draftDeletes[rowKey]) return
    if (Object.keys(draft.data).length === 0) return

    operations.push({
      type: 'update',
      schema,
      object,
      where: draft.where,
      data: draft.data,
    })
  })

  Object.values(draftDeletes).forEach((draft) => {
    operations.push({
      type: 'delete',
      schema,
      object,
      where: draft.where,
    })
  })

  draftInserts.forEach((data) => {
    operations.push({
      type: 'insert',
      schema,
      object,
      data,
    })
  })

  return {
    schema,
    object,
    operations,
  }
}
