import type { BulkMutateOp, MutateOp } from '@/types/api'

export interface DraftUpdateState {
  where: Record<string, unknown>
  data: Record<string, unknown>
}

export interface DraftDeleteState {
  where: Record<string, unknown>
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
