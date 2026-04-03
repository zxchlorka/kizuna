import type { Column, Header } from '@tanstack/react-table'
import { ChevronDown, ChevronUp, ChevronsUpDown, Key } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { ColumnMeta, TableRow } from '@/types/api'

interface ColumnHeaderProps {
  header: Header<TableRow, unknown>
  column: Column<TableRow, unknown>
  meta: ColumnMeta
}

const TYPE_COLORS: Record<string, { bg: string; text: string; border: string }> = {
  int2: { bg: 'bg-blue-500/10', text: 'text-blue-600 dark:text-blue-400', border: 'border-blue-500/30' },
  int4: { bg: 'bg-blue-500/10', text: 'text-blue-600 dark:text-blue-400', border: 'border-blue-500/30' },
  int8: { bg: 'bg-blue-500/10', text: 'text-blue-600 dark:text-blue-400', border: 'border-blue-500/30' },
  integer: { bg: 'bg-blue-500/10', text: 'text-blue-600 dark:text-blue-400', border: 'border-blue-500/30' },
  bigint: { bg: 'bg-blue-500/10', text: 'text-blue-600 dark:text-blue-400', border: 'border-blue-500/30' },
  numeric: { bg: 'bg-cyan-500/10', text: 'text-cyan-600 dark:text-cyan-400', border: 'border-cyan-500/30' },
  float4: { bg: 'bg-cyan-500/10', text: 'text-cyan-600 dark:text-cyan-400', border: 'border-cyan-500/30' },
  float8: { bg: 'bg-cyan-500/10', text: 'text-cyan-600 dark:text-cyan-400', border: 'border-cyan-500/30' },
  text: { bg: 'bg-green-500/10', text: 'text-green-600 dark:text-green-400', border: 'border-green-500/30' },
  varchar: { bg: 'bg-green-500/10', text: 'text-green-600 dark:text-green-400', border: 'border-green-500/30' },
  bool: { bg: 'bg-purple-500/10', text: 'text-purple-600 dark:text-purple-400', border: 'border-purple-500/30' },
  boolean: { bg: 'bg-purple-500/10', text: 'text-purple-600 dark:text-purple-400', border: 'border-purple-500/30' },
  timestamp: { bg: 'bg-orange-500/10', text: 'text-orange-600 dark:text-orange-400', border: 'border-orange-500/30' },
  timestamptz: { bg: 'bg-orange-500/10', text: 'text-orange-600 dark:text-orange-400', border: 'border-orange-500/30' },
  date: { bg: 'bg-orange-500/10', text: 'text-orange-600 dark:text-orange-400', border: 'border-orange-500/30' },
  uuid: { bg: 'bg-pink-500/10', text: 'text-pink-600 dark:text-pink-400', border: 'border-pink-500/30' },
  json: { bg: 'bg-yellow-500/10', text: 'text-yellow-600 dark:text-yellow-400', border: 'border-yellow-500/30' },
  jsonb: { bg: 'bg-yellow-500/10', text: 'text-yellow-600 dark:text-yellow-400', border: 'border-yellow-500/30' },
  'user-defined': { bg: 'bg-gray-500/10', text: 'text-gray-600 dark:text-gray-400', border: 'border-gray-500/30' },
}

function normalizeTypeKey(dataType: string): string {
  const lower = dataType.toLowerCase()
  const aliases: Record<string, string> = {
    'character varying': 'varchar',
    'timestamp without time zone': 'timestamp',
    'timestamp with time zone': 'timestamptz',
    'time without time zone': 'time',
    'time with time zone': 'timetz',
    'double precision': 'float8',
    real: 'float4',
    smallint: 'int2',
    'user-defined': 'user-defined',
  }
  return aliases[lower] ?? lower
}

function getTypeColors(dataType: string) {
  const key = normalizeTypeKey(dataType)
  return (
    TYPE_COLORS[key] ?? {
      bg: 'bg-gray-500/10',
      text: 'text-gray-600 dark:text-gray-400',
      border: 'border-gray-500/30',
    }
  )
}

function typeBadgeLabel(dataType: string): string {
  const key = normalizeTypeKey(dataType)
  const short: Record<string, string> = {
    integer: 'int',
    bigint: 'int8',
    int2: 'int2',
    numeric: 'num',
    float4: 'f4',
    float8: 'f8',
    timestamp: 'ts',
    timestamptz: 'tstz',
    varchar: 'varchar',
    boolean: 'bool',
    'user-defined': 'enum',
  }
  const label = short[key] ?? key
  return label.length > 12 ? `${label.slice(0, 11)}…` : label
}

export function ColumnHeader({ header, column, meta }: ColumnHeaderProps) {
  const isSorted = column.getIsSorted()
  const colors = getTypeColors(meta.data_type)
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
              colors.bg,
              colors.text,
              colors.border
            )}
            title={meta.data_type}
          >
            {typeBadgeLabel(meta.data_type)}
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
