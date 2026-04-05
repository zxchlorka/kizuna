import { useMemo, useState } from 'react'
import { Expand } from 'lucide-react'
import { LargeValueModal } from '@/components/DataTable/LargeValueModal'
import { cn } from '@/lib/utils'

interface SqlResultCellProps {
  value: unknown
  columnName: string
  columnType?: string
}

const LARGE_VALUE_LENGTH = 120

function stringifyValue(value: unknown): string {
  if (value === null || value === undefined) {
    return 'NULL'
  }
  if (typeof value === 'object') {
    return JSON.stringify(value, null, 2)
  }
  return String(value)
}

function isJsonLike(value: unknown, columnType?: string): boolean {
  const type = (columnType ?? '').toLowerCase()
  return type === 'json' || type === 'jsonb' || typeof value === 'object'
}

function isLarge(valueString: string, isJson: boolean): boolean {
  return isJson || valueString.length > LARGE_VALUE_LENGTH || valueString.includes('\n')
}

export function SqlResultCell({ value, columnName, columnType }: SqlResultCellProps) {
  const [open, setOpen] = useState(false)
  const valueString = useMemo(() => stringifyValue(value), [value])
  const jsonLike = isJsonLike(value, columnType)
  const large = isLarge(valueString, jsonLike)

  if (value === null || value === undefined) {
    return <span className="font-mono text-[12px] text-muted-foreground">NULL</span>
  }

  return (
    <>
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          {large ? (
            <div
              className={cn(
                'overflow-hidden whitespace-pre-wrap break-all text-left',
                jsonLike ? 'max-h-[5.5rem]' : 'max-h-[3.5rem]'
              )}
              style={{
                display: '-webkit-box',
                WebkitBoxOrient: 'vertical',
                WebkitLineClamp: jsonLike ? 4 : 2,
              }}
              title={valueString}
            >
              {valueString}
            </div>
          ) : (
            <span className="whitespace-pre-wrap break-all" title={valueString}>
              {valueString}
            </span>
          )}
        </div>
        {large && (
          <button
            type="button"
            className="mt-0.5 shrink-0 rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
            onClick={() => setOpen(true)}
            title="Open full value"
          >
            <Expand className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
      {large && (
        <LargeValueModal
          open={open}
          title={`${columnName}${columnType ? ` · ${columnType}` : ''}`}
          initialValue={value}
          isJson={jsonLike}
          nullable
          readOnly
          onClose={() => setOpen(false)}
          onSave={() => {}}
          onSetNull={() => {}}
        />
      )}
    </>
  )
}
