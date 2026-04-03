import { useMemo, useRef, useState } from 'react'
import {
  flexRender,
  getCoreRowModel,
  useReactTable,
  type ColumnDef,
  type ColumnResizeMode,
  type ColumnSizingState,
  type SortingState,
} from '@tanstack/react-table'
import { useVirtualizer } from '@tanstack/react-virtual'
import { Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { ColumnMeta, FilterExpr } from '@/types/api'
import { ColumnHeader } from '@/components/DataTable/ColumnHeader'
import { EditableCell } from '@/components/DataTable/EditableCell'
import { TableCheckbox } from '@/components/DataTable/TableCheckbox'

export interface ColumnFilterState {
  op: FilterExpr['op']
  value: string
}

export interface DataTableProps {
  columns: ColumnMeta[]
  rows: any[][]
  loading: boolean
  sorting: SortingState
  filterState: Record<string, ColumnFilterState>
  selectedRows: Set<number>
  editMode: boolean
  draftDeletes: Set<number>
  onSortChange: (col: string, dir: 'asc' | 'desc' | null) => void
  onFilterChange: (column: string, nextState: ColumnFilterState) => void
  onToggleRow: (rowIndex: number, checked: boolean) => void
  onToggleAll: (checked: boolean) => void
  onCellChange: (rowIndex: number, colName: string, value: any) => void
  getDraftValue: (rowIndex: number, colName: string, fallback: any) => any
  isDirtyCell: (rowIndex: number, colName: string) => boolean
}

const ROW_HEIGHT = 40
const VIRTUALIZE_THRESHOLD = 100

type TypeCategory = 'numeric' | 'text' | 'boolean' | 'temporal' | 'uuid' | 'json' | 'other'

function getTypeCategory(dataType: string): TypeCategory {
  const dt = dataType.toLowerCase()
  if (['int2','int4','int8','integer','bigint','numeric','float4','float8','decimal','smallint','real','double precision'].includes(dt)) return 'numeric'
  if (['text','varchar','char','bpchar','character varying','name'].includes(dt)) return 'text'
  if (['bool','boolean'].includes(dt)) return 'boolean'
  if (['timestamp','timestamptz','date','time','timetz','timestamp without time zone','timestamp with time zone'].includes(dt)) return 'temporal'
  if (dt === 'uuid') return 'uuid'
  if (['json','jsonb'].includes(dt)) return 'json'
  return 'other'
}

type FilterOp = { value: FilterExpr['op']; label: string }

const NULL_OPS: FilterOp[] = [
  { value: 'is_null', label: 'null' },
  { value: 'is_not_null', label: '!null' },
]

const FILTER_OPS_BY_CATEGORY: Record<TypeCategory, FilterOp[]> = {
  numeric: [
    { value: 'eq', label: '=' },
    { value: 'neq', label: '!=' },
    { value: 'gt', label: '>' },
    { value: 'gte', label: '>=' },
    { value: 'lt', label: '<' },
    { value: 'lte', label: '<=' },
    ...NULL_OPS,
  ],
  text: [
    { value: 'contains', label: '~' },
    { value: 'eq', label: '=' },
    { value: 'neq', label: '!=' },
    { value: 'like', label: 'LIKE' },
    ...NULL_OPS,
  ],
  boolean: [
    { value: 'eq', label: '=' },
    ...NULL_OPS,
  ],
  temporal: [
    { value: 'eq', label: '=' },
    { value: 'gt', label: '>' },
    { value: 'gte', label: '>=' },
    { value: 'lt', label: '<' },
    { value: 'lte', label: '<=' },
    ...NULL_OPS,
  ],
  uuid: [
    { value: 'eq', label: '=' },
    { value: 'contains', label: '~' },
    ...NULL_OPS,
  ],
  json: [
    { value: 'contains', label: '~' },
    ...NULL_OPS,
  ],
  other: [
    { value: 'contains', label: '~' },
    { value: 'eq', label: '=' },
    { value: 'neq', label: '!=' },
    { value: 'gt', label: '>' },
    { value: 'lt', label: '<' },
    { value: 'like', label: 'LIKE' },
    ...NULL_OPS,
  ],
}

const DEFAULT_OP_BY_CATEGORY: Record<TypeCategory, FilterExpr['op']> = {
  numeric: 'eq',
  text: 'contains',
  boolean: 'eq',
  temporal: 'eq',
  uuid: 'eq',
  json: 'contains',
  other: 'contains',
}

export function DataTable({
  columns: columnMetas,
  rows,
  loading,
  sorting,
  filterState,
  selectedRows,
  editMode,
  draftDeletes,
  onSortChange,
  onFilterChange,
  onToggleRow,
  onToggleAll,
  onCellChange,
  getDraftValue,
  isDirtyCell,
}: DataTableProps) {
  const parentRef = useRef<HTMLDivElement>(null)
  const [columnSizing, setColumnSizing] = useState<ColumnSizingState>({})
  const columnMetaByName = useMemo(() => new Map(columnMetas.map((c) => [c.name, c])), [columnMetas])

  const columnDefs = useMemo<ColumnDef<any[]>[]>(() => {
    const selectColumn: ColumnDef<any[]> = {
      id: '__select__',
      header: () => (
        <div className="flex h-9 w-full items-center justify-center">
          <TableCheckbox
            checked={rows.length > 0 && selectedRows.size === rows.length}
            indeterminate={selectedRows.size > 0 && selectedRows.size < rows.length}
            onChange={onToggleAll}
          />
        </div>
      ),
      cell: ({ row }) => (
        <div className="flex h-full items-center justify-center">
          <TableCheckbox
            checked={selectedRows.has(row.index)}
            onChange={(checked) => onToggleRow(row.index, checked)}
          />
        </div>
      ),
      size: 52,
      minSize: 52,
      maxSize: 52,
      enableResizing: false,
      enableSorting: false,
    }

    const dataColumns = columnMetas.map((col, colIndex) => ({
      id: col.name,
      accessorFn: (row: any[]) => row[colIndex],
      header: ({ header, column }: any) => <ColumnHeader header={header} column={column} meta={col} />,
      cell: ({ row, cell }: any) => (
        <EditableCell
          value={getDraftValue(row.index, col.name, cell.getValue())}
          colMeta={col}
          editMode={editMode}
          dirty={isDirtyCell(row.index, col.name)}
          rowDeleted={draftDeletes.has(row.index)}
          onChange={(newValue) => onCellChange(row.index, col.name, newValue)}
        />
      ),
      size: 170,
      minSize: 90,
      enableResizing: true,
      enableSorting: true,
    }))

    return [selectColumn, ...dataColumns]
  }, [
    columnMetas,
    rows.length,
    selectedRows,
    onToggleAll,
    onToggleRow,
    getDraftValue,
    editMode,
    isDirtyCell,
    draftDeletes,
    onCellChange,
  ])

  const table = useReactTable({
    data: rows,
    columns: columnDefs,
    getCoreRowModel: getCoreRowModel(),
    state: { sorting, columnSizing },
    onSortingChange: (updater) => {
      const next = typeof updater === 'function' ? updater(sorting) : updater
      const nonSelect = next.find((s) => s.id !== '__select__')
      if (!nonSelect) {
        if (sorting.length > 0) {
          onSortChange(sorting[0].id, null)
        }
        return
      }
      onSortChange(nonSelect.id, nonSelect.desc ? 'desc' : 'asc')
    },
    manualSorting: true,
    manualPagination: true,
    columnResizeMode: 'onChange' as ColumnResizeMode,
    onColumnSizingChange: setColumnSizing,
    enableSortingRemoval: true,
  })

  const tableRows = table.getRowModel().rows
  const useVirtualization = tableRows.length > VIRTUALIZE_THRESHOLD

  const virtualizer = useVirtualizer({
    count: useVirtualization ? tableRows.length : 0,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 10,
    enabled: useVirtualization,
  })

  const virtualItems = useVirtualization ? virtualizer.getVirtualItems() : []
  const totalVirtualSize = useVirtualization ? virtualizer.getTotalSize() : 0

  return (
    <div className="relative flex h-full w-full flex-col overflow-hidden rounded-md border border-border bg-background">
      {loading && (
        <div className="absolute inset-0 z-20 flex items-center justify-center bg-background/55 backdrop-blur-[1px]">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      )}

      <div ref={parentRef} className="flex-1 overflow-auto">
        <table className="border-collapse text-sm" style={{ width: table.getCenterTotalSize(), minWidth: '100%' }}>
          <thead className="sticky top-0 z-10 bg-muted/90 backdrop-blur supports-[backdrop-filter]:bg-muted/75">
            {table.getHeaderGroups().map((headerGroup) => (
              <tr key={headerGroup.id} className="border-b border-border">
                {headerGroup.headers.map((header) => (
                  <th
                    key={header.id}
                    className={cn(
                      'relative h-9 border-r border-border px-0 text-left align-middle font-medium text-muted-foreground',
                      'last:border-r-0 select-none'
                    )}
                    style={{ width: header.getSize() }}
                  >
                    {header.isPlaceholder ? null : flexRender(header.column.columnDef.header, header.getContext())}
                  </th>
                ))}
              </tr>
            ))}

            <tr className="border-b border-border bg-muted/55">
              {table.getLeafHeaders().map((header) => (
                <th
                  key={`filter-${header.id}`}
                  className="h-8 border-r border-border px-1 py-0 align-middle last:border-r-0"
                  style={{ width: header.getSize() }}
                >
                  {header.column.id === '__select__'
                    ? null
                    : (() => {
                        const colId = header.column.id
                        const meta = columnMetaByName.get(colId)
                        if (!meta) return null

                        const category = getTypeCategory(meta.data_type)
                        const ops = FILTER_OPS_BY_CATEGORY[category]
                        const defaultOp = DEFAULT_OP_BY_CATEGORY[category]
                        const saved = filterState[colId]
                        const opValid = saved && ops.some((o) => o.value === saved.op)
                        const state = opValid ? saved : { op: defaultOp, value: '' }
                        const isNullOp = state.op === 'is_null' || state.op === 'is_not_null'

                        return (
                          <div className="flex items-center gap-0.5">
                            <select
                              value={state.op}
                              onChange={(e) => onFilterChange(colId, { ...state, op: e.target.value as FilterExpr['op'] })}
                              className="h-6 w-[52px] shrink-0 rounded border border-border bg-background px-1 text-[11px] text-foreground outline-none ring-ring/20 focus:ring-2"
                              title="Filter operator"
                            >
                              {ops.map((op) => (
                                <option key={op.value} value={op.value}>
                                  {op.label}
                                </option>
                              ))}
                            </select>
                            {!isNullOp && (
                              <input
                                type="text"
                                placeholder="filter..."
                                value={state.value}
                                onChange={(e) => onFilterChange(colId, { ...state, value: e.target.value })}
                                className="h-6 w-full min-w-0 rounded border border-border bg-background px-1.5 text-xs text-foreground placeholder:text-muted-foreground/60 outline-none ring-ring/20 focus:ring-2"
                              />
                            )}
                          </div>
                        )
                      })()}
                </th>
              ))}
            </tr>
          </thead>

          <tbody className="relative" style={useVirtualization ? { height: `${totalVirtualSize}px` } : undefined}>
            {useVirtualization
              ? virtualItems.map((virtualRow) => {
                  const row = tableRows[virtualRow.index]
                  const rowDeleted = draftDeletes.has(row.index)
                  return (
                    <tr
                      key={row.id}
                      className={cn(
                        'absolute left-0 top-0 w-full border-b border-border transition-colors',
                        rowDeleted ? 'bg-destructive/5' : 'hover:bg-muted/35'
                      )}
                      style={{
                        height: `${virtualRow.size}px`,
                        transform: `translateY(${virtualRow.start}px)`,
                      }}
                    >
                      {row.getVisibleCells().map((cell) => (
                        <td
                          key={cell.id}
                          className="overflow-hidden border-r border-border p-0 align-middle last:border-r-0"
                          style={{ width: cell.column.getSize(), height: ROW_HEIGHT }}
                        >
                          {flexRender(cell.column.columnDef.cell, cell.getContext())}
                        </td>
                      ))}
                    </tr>
                  )
                })
              : tableRows.map((row) => {
                  const rowDeleted = draftDeletes.has(row.index)
                  return (
                    <tr
                      key={row.id}
                      className={cn(
                        'border-b border-border transition-colors',
                        rowDeleted ? 'bg-destructive/5' : 'hover:bg-muted/35'
                      )}
                      style={{ height: `${ROW_HEIGHT}px` }}
                    >
                      {row.getVisibleCells().map((cell) => (
                        <td
                          key={cell.id}
                          className="overflow-hidden border-r border-border p-0 align-middle last:border-r-0"
                          style={{ width: cell.column.getSize(), height: ROW_HEIGHT }}
                        >
                          {flexRender(cell.column.columnDef.cell, cell.getContext())}
                        </td>
                      ))}
                    </tr>
                  )
                })}

            {!loading && tableRows.length === 0 && (
              <tr>
                <td colSpan={columnMetas.length + 1} className="h-24 text-center text-sm text-muted-foreground">
                  No rows found
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}
