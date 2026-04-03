import { useEffect, useState } from 'react'
import { X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import type { ColumnMeta } from '@/types/api'

interface AddRowDialogProps {
  open: boolean
  object: string
  columns: ColumnMeta[]
  editMode: boolean
  saving: boolean
  onClose: () => void
  onSubmit: (data: Record<string, unknown>) => Promise<void>
}

const INTEGER_TYPES = new Set(['int2', 'int4', 'int8', 'integer', 'bigint'])
const NUMERIC_TYPES = new Set(['numeric', 'float4', 'float8', 'decimal'])
const BOOL_TYPES = new Set(['bool', 'boolean'])
const JSON_TYPES = new Set(['json', 'jsonb'])
const UUID_TYPES = new Set(['uuid'])
const TEXT_TYPES = new Set(['text', 'varchar', 'bpchar', 'char'])
const BOOL_DEFAULT_SENTINEL = '__default__'

function hasUUIDDefault(column: ColumnMeta): boolean {
  if (!column.default) return false
  const lower = column.default.toLowerCase()
  return lower.includes('uuid_generate') || lower.includes('gen_random_uuid')
}

function parseFormValue(raw: string, column: ColumnMeta): { include: boolean; value?: unknown; error?: string } {
  if (raw === BOOL_DEFAULT_SENTINEL) {
    if (!column.nullable && !column.default) {
      return { include: false, error: 'Required field' }
    }
    return { include: false }
  }

  const dt = column.data_type.toLowerCase()
  const trimmed = raw.trim()

  if (trimmed === '') {
    if (UUID_TYPES.has(dt) && hasUUIDDefault(column)) {
      return { include: false }
    }
    if (column.default) {
      return { include: false }
    }
    if (TEXT_TYPES.has(dt)) {
      return { include: true, value: '' }
    }
    if (column.nullable) {
      return { include: true, value: null }
    }
    return { include: false, error: 'Required field' }
  }

  if (BOOL_TYPES.has(dt)) {
    if (trimmed !== 'true' && trimmed !== 'false' && trimmed !== 'null') {
      return { include: false, error: 'Use true/false/null' }
    }
    if (trimmed === 'null') {
      if (!column.nullable) return { include: false, error: 'Column is not nullable' }
      return { include: true, value: null }
    }
    return { include: true, value: trimmed === 'true' }
  }

  if (INTEGER_TYPES.has(dt)) {
    const parsed = Number(trimmed)
    if (!Number.isInteger(parsed)) return { include: false, error: 'Integer expected' }
    return { include: true, value: parsed }
  }

  if (NUMERIC_TYPES.has(dt)) {
    const parsed = Number(trimmed)
    if (Number.isNaN(parsed)) return { include: false, error: 'Numeric value expected' }
    return { include: true, value: parsed }
  }

  if (UUID_TYPES.has(dt)) {
    const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    if (!uuidRe.test(trimmed)) return { include: false, error: 'Invalid UUID' }
    return { include: true, value: trimmed }
  }

  if (JSON_TYPES.has(dt)) {
    try {
      return { include: true, value: JSON.parse(raw) }
    } catch {
      return { include: false, error: 'Invalid JSON' }
    }
  }

  return { include: true, value: raw }
}

function createInitialRowData(columns: ColumnMeta[]): Record<string, string> {
  const initial: Record<string, string> = {}
  columns.forEach((column) => {
    const dt = column.data_type.toLowerCase()
    initial[column.name] = BOOL_TYPES.has(dt) ? BOOL_DEFAULT_SENTINEL : ''
  })
  return initial
}

export function AddRowDialog({
  open,
  object,
  columns,
  editMode,
  saving,
  onClose,
  onSubmit,
}: AddRowDialogProps) {
  const [newRowData, setNewRowData] = useState<Record<string, string>>({})
  const [newRowErrors, setNewRowErrors] = useState<Record<string, string>>({})

  useEffect(() => {
    if (!open) return
    setNewRowData(createInitialRowData(columns))
    setNewRowErrors({})
  }, [columns, open])

  if (!open) {
    return null
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="flex max-h-[85vh] w-full max-w-5xl flex-col rounded-lg border border-border bg-background shadow-2xl">
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <div>
            <h3 className="text-sm font-semibold text-foreground">Add row to {object}</h3>
            <p className="text-xs text-muted-foreground">Fill only required fields. Empty optional fields use DB defaults/NULL.</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="grid max-h-[65vh] grid-cols-1 gap-3 overflow-auto p-4 md:grid-cols-2 xl:grid-cols-3">
          {columns.map((column) => {
            const dt = column.data_type.toLowerCase()
            const isBool = BOOL_TYPES.has(dt)
            const isJson = JSON_TYPES.has(dt)
            const helper = UUID_TYPES.has(dt) && hasUUIDDefault(column) ? 'leave empty for DB-generated UUID' : null

            return (
              <div key={column.name} className="space-y-1">
                <label className="block text-xs font-medium text-foreground">
                  {column.name}
                  <span className="ml-1 text-[10px] text-muted-foreground">({column.data_type})</span>
                </label>

                {isBool ? (
                  <Select
                    value={newRowData[column.name] ?? BOOL_DEFAULT_SENTINEL}
                    onValueChange={(value) => {
                      setNewRowData((prev) => ({ ...prev, [column.name]: value }))
                      setNewRowErrors((prev) => ({ ...prev, [column.name]: '' }))
                    }}
                  >
                    <SelectTrigger className="h-8 text-xs">
                      <SelectValue placeholder={column.nullable ? 'default / null' : 'select'} />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={BOOL_DEFAULT_SENTINEL}>default</SelectItem>
                      <SelectItem value="true">true</SelectItem>
                      <SelectItem value="false">false</SelectItem>
                      {column.nullable && <SelectItem value="null">null</SelectItem>}
                    </SelectContent>
                  </Select>
                ) : isJson ? (
                  <textarea
                    value={newRowData[column.name] ?? ''}
                    onChange={(e) => {
                      setNewRowData((prev) => ({ ...prev, [column.name]: e.target.value }))
                      setNewRowErrors((prev) => ({ ...prev, [column.name]: '' }))
                    }}
                    placeholder={helper ?? (column.nullable ? 'empty => null/default' : '')}
                    rows={4}
                    className="w-full resize-y rounded border border-border bg-background px-2 py-1.5 text-xs font-mono outline-none ring-ring/20 focus:ring-2"
                  />
                ) : (
                  <input
                    value={newRowData[column.name] ?? ''}
                    onChange={(e) => {
                      setNewRowData((prev) => ({ ...prev, [column.name]: e.target.value }))
                      setNewRowErrors((prev) => ({ ...prev, [column.name]: '' }))
                    }}
                    placeholder={helper ?? (column.nullable ? 'empty => null/default' : '')}
                    className="h-8 w-full rounded border border-border bg-background px-2 text-xs outline-none ring-ring/20 focus:ring-2"
                  />
                )}

                {helper && <p className="text-[10px] text-muted-foreground">{helper}</p>}
                {newRowErrors[column.name] && <p className="text-[10px] text-destructive">{newRowErrors[column.name]}</p>}
              </div>
            )
          })}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-border px-4 py-3">
          <Button variant="outline" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button
            size="sm"
            onClick={async () => {
              const validationErrors: Record<string, string> = {}
              const data: Record<string, unknown> = {}

              columns.forEach((column) => {
                const parsed = parseFormValue(newRowData[column.name] ?? '', column)
                if (parsed.error) {
                  validationErrors[column.name] = parsed.error
                  return
                }
                if (parsed.include) {
                  data[column.name] = parsed.value
                }
              })

              if (Object.keys(validationErrors).length > 0) {
                setNewRowErrors(validationErrors)
                return
              }

              try {
                await onSubmit(data)
              } catch {
                // Parent component surfaces the request error.
              }
            }}
            disabled={saving}
          >
            {editMode ? 'Stage row' : 'Insert row'}
          </Button>
        </div>
      </div>
    </div>
  )
}
