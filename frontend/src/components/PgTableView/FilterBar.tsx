import { useState, useEffect, useRef, useCallback } from 'react'
import { X } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { ColumnMeta, FilterExpr } from '@/types/api'

interface FilterBarProps {
  columns: ColumnMeta[]
  filters: FilterExpr[]
  onChange: (filters: FilterExpr[]) => void
}

const DEBOUNCE_MS = 300

export function FilterBar({ columns, filters, onChange }: FilterBarProps) {
  // Local input state keyed by column name
  const [inputValues, setInputValues] = useState<Record<string, string>>(() => {
    const init: Record<string, string> = {}
    filters.forEach((f) => {
      init[f.column] = f.value
    })
    return init
  })

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const emitChange = useCallback(
    (values: Record<string, string>) => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
      debounceRef.current = setTimeout(() => {
        const newFilters: FilterExpr[] = Object.entries(values)
          .filter(([, v]) => v.trim() !== '')
          .map(([col, v]) => ({ column: col, op: 'contains' as const, value: v.trim() }))
        onChange(newFilters)
      }, DEBOUNCE_MS)
    },
    [onChange]
  )

  const handleChange = (colName: string, value: string) => {
    const next = { ...inputValues, [colName]: value }
    if (!value) delete next[colName]
    setInputValues(next)
    emitChange(next)
  }

  const handleClear = (colName: string) => {
    const next = { ...inputValues }
    delete next[colName]
    setInputValues(next)
    emitChange(next)
  }

  // Cleanup timeout on unmount
  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
    }
  }, [])

  if (columns.length === 0) return null

  return (
    <tr className="border-b border-border bg-muted/30">
      {columns.map((col) => {
        const val = inputValues[col.name] ?? ''
        return (
          <td
            key={col.name}
            className="h-8 border-r border-border last:border-r-0 p-0 align-middle"
          >
            <div className="relative flex items-center h-full px-1">
              <input
                type="text"
                value={val}
                onChange={(e) => handleChange(col.name, e.target.value)}
                placeholder="filter..."
                className={cn(
                  'h-6 w-full min-w-0 rounded border-0 bg-transparent px-1.5 text-xs',
                  'text-foreground placeholder:text-muted-foreground/50',
                  'focus:outline-none focus:ring-1 focus:ring-ring',
                  val ? 'pr-5' : ''
                )}
              />
              {val && (
                <button
                  onClick={() => handleClear(col.name)}
                  className="absolute right-1.5 flex h-4 w-4 items-center justify-center rounded-full text-muted-foreground hover:text-foreground"
                  tabIndex={-1}
                  aria-label={`Clear filter for ${col.name}`}
                >
                  <X className="h-2.5 w-2.5" />
                </button>
              )}
            </div>
          </td>
        )
      })}
    </tr>
  )
}
