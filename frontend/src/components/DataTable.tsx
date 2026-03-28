import { useEffect, useMemo, useRef, useState } from 'react'
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

export interface DataTableProps {
  columns: ColumnMeta[]
  rows: any[][]
  loading: boolean
  sorting: SortingState
  filters: FilterExpr[]
  selectedRows: Set<number>
  editMode: boolean
  draftDeletes: Set<number>
  onSortChange: (col: string, dir: 'asc' | 'desc' | null) => void
  onFilterChange: (filters: FilterExpr[]) => void
  onToggleRow: (rowIndex: number, checked: boolean) => void
  onToggleAll: (checked: boolean) => void
  onCellChange: (rowIndex: number, colName: string, value: any) => void
  getDraftValue: (rowIndex: number, colName: string, fallback: any) => any
  isDirtyCell: (rowIndex: number, colName: string) => boolean
}

const ROW_HEIGHT = 40
const VIRTUALIZE_THRESHOLD = 100
const FILTER_DEBOUNCE_MS = 300

function filtersToMap(filters: FilterExpr[]): Record<string, string> {
  const out: Record<string, string> = {}
  filters.forEach((f) => {
    out[f.column] = f.value
  })
  return out
}

export function DataTable({
  columns: columnMetas,
  rows,
  loading,
  sorting,
  filters,
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
  const [filterValues, setFilterValues] = useState<Record<string, string>>(() => filtersToMap(filters))

  useEffect(() => {
    setFilterValues(filtersToMap(filters))
  }, [filters])

  useEffect(() => {
    const timeout = setTimeout(() => {
      const nextFilters: FilterExpr[] = Object.entries(filterValues)
        .filter(([, value]) => value.trim() !== '')
        .map(([column, value]) => ({ column, value: value.trim(), op: 'contains' }))
      onFilterChange(nextFilters)
    }, FILTER_DEBOUNCE_MS)

    return () => clearTimeout(timeout)
  }, [filterValues, onFilterChange])

  const columnDefs = useMemo<ColumnDef<any[]>[]>(() => {
    const selectColumn: ColumnDef<any[]> = {
      id: '__select__',
      header: () => (
        <div className="flex h-full items-center justify-center">
          <input
            type="checkbox"
            className="h-3.5 w-3.5 cursor-pointer rounded border-border accent-primary"
            checked={rows.length > 0 && selectedRows.size === rows.length}
            onChange={(e) => onToggleAll(e.target.checked)}
          />
        </div>
      ),
      cell: ({ row }) => (
        <div className="flex h-full items-center justify-center">
          <input
            type="checkbox"
            className="h-3.5 w-3.5 cursor-pointer rounded border-border accent-primary"
            checked={selectedRows.has(row.index)}
            onChange={(e) => onToggleRow(row.index, e.target.checked)}
          />
        </div>
      ),
      size: 40,
      minSize: 40,
      maxSize: 40,
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
                      'relative h-9 overflow-hidden border-r border-border px-0 text-left align-middle font-medium text-muted-foreground',
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
                  {header.column.id === '__select__' ? null : (
                    <input
                      type="text"
                      placeholder="filter..."
                      value={filterValues[header.column.id] ?? ''}
                      onChange={(e) =>
                        setFilterValues((prev) => ({
                          ...prev,
                          [header.column.id]: e.target.value,
                        }))
                      }
                      className="h-6 w-full min-w-0 rounded border border-border bg-background px-1.5 text-xs text-foreground placeholder:text-muted-foreground/60 outline-none ring-ring/20 focus:ring-2"
                    />
                  )}
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
                          style={{ width: cell.column.getSize() }}
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
                          style={{ width: cell.column.getSize() }}
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
