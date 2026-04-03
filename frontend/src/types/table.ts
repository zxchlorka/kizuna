import type { FilterExpr } from '@/types/api'

export interface ColumnFilterState {
  op: FilterExpr['op']
  value: string
}

export interface RowIdentity {
  rowKey: string
  where: Record<string, unknown>
}
