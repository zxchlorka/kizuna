import { useState } from 'react'
import { cn } from '@/lib/utils'
import type { ExecResult } from '@/types/api'

interface RedisResultTableProps {
  result: ExecResult
}

function formatCell(value: unknown): string {
  if (value === null || value === undefined) {
    return '(nil)'
  }
  if (typeof value === 'object') {
    return JSON.stringify(value)
  }
  return String(value)
}

// Expanded cells pretty-print JSON strings/objects; everything else is shown raw.
function formatExpanded(value: unknown): string {
  if (value === null || value === undefined) {
    return '(nil)'
  }
  if (typeof value === 'string') {
    try {
      return JSON.stringify(JSON.parse(value), null, 2)
    } catch {
      return value
    }
  }
  if (typeof value === 'object') {
    return JSON.stringify(value, null, 2)
  }
  return String(value)
}

export function RedisResultTable({ result }: RedisResultTableProps) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set())

  const toggle = (key: string) => {
    setExpanded((current) => {
      const next = new Set(current)
      if (next.has(key)) {
        next.delete(key)
      } else {
        next.add(key)
      }
      return next
    })
  }

  if (result.rows.length === 0) {
    return <div className="font-mono text-sm text-muted-foreground">(empty)</div>
  }

  const columnTypes = result.column_types ?? []

  return (
    <div className="overflow-x-auto rounded-sm border border-border/70">
      <table className="min-w-[260px] divide-y divide-border text-sm">
        <thead className="bg-muted/30 text-left text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
          <tr>
            {result.columns.map((column) => (
              <th key={column} className="px-3 py-2 font-medium">
                {column}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-border/60">
          {result.rows.map((row, rowIndex) => (
            <tr key={rowIndex} className="align-top">
              {result.columns.map((_, colIndex) => {
                const cellKey = `${rowIndex}:${colIndex}`
                const isExpanded = expanded.has(cellKey)
                const raw = row[colIndex]
                const display = formatCell(raw)
                const isNumeric = columnTypes[colIndex] === 'integer' || columnTypes[colIndex] === 'float'
                const isKeyColumn = colIndex === 0

                return (
                  <td
                    key={colIndex}
                    onClick={() => toggle(cellKey)}
                    className="cursor-pointer px-3 py-2"
                  >
                    {isExpanded ? (
                      <pre
                        className={cn(
                          'whitespace-pre-wrap break-all font-mono text-xs',
                          isKeyColumn ? 'font-medium text-accent' : 'text-foreground',
                          isNumeric && 'tabular-nums'
                        )}
                      >
                        {formatExpanded(raw)}
                      </pre>
                    ) : (
                      <div
                        title={display}
                        className={cn(
                          'max-w-[28rem] truncate font-mono text-xs',
                          isKeyColumn ? 'font-medium text-accent' : 'text-foreground',
                          isNumeric && 'tabular-nums'
                        )}
                      >
                        {display}
                      </div>
                    )}
                  </td>
                )
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
