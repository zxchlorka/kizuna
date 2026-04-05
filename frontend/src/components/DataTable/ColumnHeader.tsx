import type { Column, Header } from '@tanstack/react-table'
import { ChevronDown, ChevronUp, ChevronsUpDown, Key } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { ColumnMeta, TableRow } from '@/types/api'
import { getPostgresTypeBadge } from '@/lib/postgresTypes'

interface ColumnHeaderProps {
  header: Header<TableRow, unknown>
  column: Column<TableRow, unknown>
  meta: ColumnMeta
}

export function ColumnHeader({ header, column, meta }: ColumnHeaderProps) {
  const isSorted = column.getIsSorted()
  const badge = getPostgresTypeBadge(meta.data_type)
  const width = header.getSize()
  const sortReserve = column.getCanSort() ? 18 : 0
  const pkReserve = meta.is_pk ? 20 : 0
  const horizontalPadding = 18
  const gapReserve = 12
  const minNameBudget = 44
  const freeWidth = width - sortReserve - pkReserve - horizontalPadding - gapReserve
  const showTypeBadge = width >= 120 && freeWidth >= minNameBudget
  const headerTitle = meta.is_fk && meta.fk_table
    ? `${meta.name} (${meta.data_type}) • FK -> ${meta.fk_table}${meta.fk_column ? `.${meta.fk_column}` : ''}`
    : `${meta.name} (${meta.data_type})`

  const handleSortClick = () => {
    if (!column.getCanSort()) return
    if (isSorted === false) {
      column.toggleSorting(false)
    } else if (isSorted === 'asc') {
      column.toggleSorting(true)
    } else {
      column.clearSorting()
    }
  }

  return (
    <div className="relative flex h-full w-full items-center gap-1.5 pr-2">
      <button
        className={cn(
          'group flex h-full min-w-0 flex-1 items-center gap-1.5 text-left',
          column.getCanSort() && 'cursor-pointer select-none'
        )}
        onClick={handleSortClick}
        tabIndex={column.getCanSort() ? 0 : undefined}
        title={headerTitle}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            handleSortClick()
          }
        }}
      >
        {meta.is_pk && (
          <span className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded border border-amber-500/30 bg-amber-500/10">
            <Key className="h-2.5 w-2.5 text-amber-500" />
          </span>
        )}

        <span className="min-w-0 truncate text-xs font-semibold text-foreground">{meta.name}</span>

        {showTypeBadge && (
          <span
            className={cn(
              'inline-flex shrink-0 items-center rounded border px-1.5 py-0.5 text-[10px] font-medium',
              badge.className
            )}
            title={badge.title}
          >
            {badge.label}
          </span>
        )}

        {column.getCanSort() && (
          <span className="ml-auto shrink-0">
            {isSorted === 'asc' ? (
              <ChevronUp className="h-3.5 w-3.5 text-foreground" />
            ) : isSorted === 'desc' ? (
              <ChevronDown className="h-3.5 w-3.5 text-foreground" />
            ) : (
              <ChevronsUpDown className="h-3.5 w-3.5 text-muted-foreground opacity-40 transition-opacity group-hover:opacity-80" />
            )}
          </span>
        )}
      </button>

      <div
        onMouseDown={header.getResizeHandler()}
        onTouchStart={header.getResizeHandler()}
        className={cn(
          'absolute right-0 top-0 z-20 h-full w-3 cursor-col-resize select-none touch-none group/resize',
          'flex items-center justify-end',
        )}
        onClick={(e) => e.stopPropagation()}
      >
        <div className={cn(
          'h-1/2 w-px bg-border transition-colors',
          'group-hover/resize:bg-primary/60 group-active/resize:bg-primary',
          column.getIsResizing() && 'bg-primary w-[2px]'
        )} />
      </div>
    </div>
  )
}
