import { useEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, ChevronRight, Expand, Pencil } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { ColumnMeta } from '@/types/api'
import { LargeValueModal } from '@/components/DataTable/LargeValueModal'

interface EditableCellProps {
  value: any
  colMeta: ColumnMeta
  editMode: boolean
  dirty: boolean
  rowDeleted: boolean
  onChange: (newValue: any) => void
}

const TIMESTAMP_TYPES = new Set(['timestamp', 'timestamptz', 'date', 'time', 'timetz'])
const BOOL_TYPES = new Set(['bool', 'boolean'])
const JSON_TYPES = new Set(['json', 'jsonb'])
const INTEGER_TYPES = new Set(['int2', 'int4', 'int8', 'integer', 'bigint'])
const NUMERIC_TYPES = new Set(['numeric', 'float4', 'float8', 'decimal'])
const UUID_TYPES = new Set(['uuid'])
const TEXT_TYPES = new Set(['text', 'varchar', 'bpchar', 'char'])

function formatTimestamp(value: any): string {
  try {
    const d = new Date(value)
    if (Number.isNaN(d.getTime())) return String(value)
    const pad = (n: number) => String(n).padStart(2, '0')
    return (
      `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
      `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
    )
  } catch {
    return String(value)
  }
}

function toInputValue(value: any): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'object') return JSON.stringify(value, null, 2)
  return String(value)
}

function parseValue(raw: string, dataType: string, nullable: boolean): { value?: any; error?: string } {
  const dt = dataType.toLowerCase()
  const trimmed = raw.trim()

  if (trimmed === '') {
    if (TEXT_TYPES.has(dt)) {
      return { value: '' }
    }
    if (nullable) {
      return { value: null }
    }
    return { error: 'Value is required for this column' }
  }

  if (INTEGER_TYPES.has(dt)) {
    const parsed = Number(trimmed)
    if (!Number.isInteger(parsed)) return { error: 'Integer expected' }
    return { value: parsed }
  }

  if (NUMERIC_TYPES.has(dt)) {
    const parsed = Number(trimmed)
    if (Number.isNaN(parsed)) return { error: 'Numeric value expected' }
    return { value: parsed }
  }

  if (BOOL_TYPES.has(dt)) {
    if (trimmed !== 'true' && trimmed !== 'false') return { error: 'Boolean expected (true/false)' }
    return { value: trimmed === 'true' }
  }

  if (UUID_TYPES.has(dt)) {
    const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    if (!uuidRe.test(trimmed)) return { error: 'Valid UUID expected' }
    return { value: trimmed }
  }

  if (JSON_TYPES.has(dt)) {
    try {
      return { value: JSON.parse(raw) }
    } catch {
      return { error: 'Invalid JSON' }
    }
  }

  return { value: raw }
}

export function EditableCell({
  value,
  colMeta,
  editMode,
  dirty,
  rowDeleted,
  onChange,
}: EditableCellProps) {
  const [isEditing, setIsEditing] = useState(false)
  const [inputValue, setInputValue] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [jsonExpanded, setJsonExpanded] = useState(false)
  const [largeEditorOpen, setLargeEditorOpen] = useState(false)
  const inputRef = useRef<HTMLInputElement | HTMLTextAreaElement>(null)

  const dataType = colMeta.data_type.toLowerCase()
  const isBool = BOOL_TYPES.has(dataType)
  const isTimestamp = TIMESTAMP_TYPES.has(dataType)
  const isJson = JSON_TYPES.has(dataType)
  const isInteger = INTEGER_TYPES.has(dataType)
  const isNumeric = NUMERIC_TYPES.has(dataType)
  const isFk = colMeta.is_fk && !!colMeta.fk_table

  const textValue = useMemo(() => toInputValue(value), [value])
  const largeValue = typeof textValue === 'string' && textValue.length > 120

  useEffect(() => {
    if (isEditing && inputRef.current) {
      inputRef.current.focus()
      if (inputRef.current instanceof HTMLInputElement) {
        inputRef.current.select()
      }
    }
  }, [isEditing])

  useEffect(() => {
    if (!editMode) {
      setIsEditing(false)
      setError(null)
    }
  }, [editMode])

  const startEdit = () => {
    if (!editMode || rowDeleted || isBool) return
    setInputValue(textValue)
    setError(null)
    setIsEditing(true)
  }

  const cancelEdit = () => {
    setIsEditing(false)
    setError(null)
  }

  const commitEdit = () => {
    const parsed = parseValue(inputValue, dataType, colMeta.nullable)
    if (parsed.error) {
      setError(parsed.error)
      return
    }
    onChange(parsed.value)
    setIsEditing(false)
    setError(null)
  }

  const setNull = () => {
    if (!colMeta.nullable) {
      setError('Column is not nullable')
      return
    }
    onChange(null)
    setIsEditing(false)
    setError(null)
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      cancelEdit()
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      commitEdit()
    }
  }

  const onBoolChange = (checked: boolean) => {
    if (!editMode || rowDeleted) return
    onChange(checked)
  }

  const cellClasses = cn(
    'relative flex h-full items-center px-2 py-1 text-xs',
    rowDeleted && 'opacity-50 line-through',
    dirty && 'bg-amber-500/10',
    error && 'ring-1 ring-destructive'
  )

  if (isEditing) {
    const multiline = isJson || largeValue
    return (
      <div className="relative h-full w-full p-1">
        {multiline ? (
          <textarea
            ref={inputRef as React.RefObject<HTMLTextAreaElement>}
            value={inputValue}
            onChange={(e) => {
              setInputValue(e.target.value)
              setError(null)
            }}
            onKeyDown={handleKeyDown}
            rows={3}
            className="h-full min-h-[34px] w-full resize-none rounded border border-ring/40 bg-background px-2 py-1 text-xs font-mono outline-none ring-ring/20 focus:ring-2"
          />
        ) : (
          <input
            ref={inputRef as React.RefObject<HTMLInputElement>}
            type={isInteger || isNumeric ? 'text' : 'text'}
            value={inputValue}
            onChange={(e) => {
              setInputValue(e.target.value)
              setError(null)
            }}
            onKeyDown={handleKeyDown}
            className="h-full w-full rounded border border-ring/40 bg-background px-2 py-1 text-xs outline-none ring-ring/20 focus:ring-2"
          />
        )}

        <div className="absolute bottom-1 right-1 flex items-center gap-1">
          {colMeta.nullable && (
            <button
              type="button"
              className="rounded border border-border bg-background px-1 py-0.5 text-[10px] text-muted-foreground hover:text-foreground"
              onClick={setNull}
            >
              NULL
            </button>
          )}
          <button
            type="button"
            className="rounded border border-border bg-background px-1 py-0.5 text-[10px] text-muted-foreground hover:text-foreground"
            onClick={commitEdit}
          >
            Save
          </button>
          <button
            type="button"
            className="rounded border border-border bg-background px-1 py-0.5 text-[10px] text-muted-foreground hover:text-foreground"
            onClick={cancelEdit}
          >
            Cancel
          </button>
        </div>
        {error && <div className="absolute left-1 top-1 text-[10px] text-destructive">{error}</div>}
      </div>
    )
  }

  if (value === null || value === undefined) {
    return (
      <div className={cellClasses} onDoubleClick={startEdit}>
        <span className="font-mono text-xs text-muted-foreground">NULL</span>
        {editMode && !rowDeleted && (
          <button
            type="button"
            className="ml-auto rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
            onClick={startEdit}
          >
            <Pencil className="h-3 w-3" />
          </button>
        )}
      </div>
    )
  }

  if (isBool) {
    return (
      <div className={cellClasses}>
        <input
          type="checkbox"
          checked={Boolean(value)}
          disabled={!editMode || rowDeleted}
          onChange={(e) => onBoolChange(e.target.checked)}
          className="h-3.5 w-3.5 cursor-pointer rounded border-border accent-primary disabled:cursor-not-allowed"
        />
      </div>
    )
  }

  const openLargeEditor = () => {
    if (rowDeleted) return
    setLargeEditorOpen(true)
  }

  return (
    <>
      <div className={cellClasses} onDoubleClick={startEdit}>
        {isJson && typeof value === 'object' ? (
          <button
            type="button"
            className="mr-1 rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
            onClick={(e) => {
              e.stopPropagation()
              setJsonExpanded((v) => !v)
            }}
          >
            {jsonExpanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
          </button>
        ) : null}

        <span className={cn('min-w-0 truncate', largeValue && 'max-w-[420px]', isTimestamp && 'font-mono')}
          title={typeof value === 'string' ? value : undefined}
        >
          {isTimestamp
            ? formatTimestamp(value)
            : isJson && typeof value === 'object'
              ? jsonExpanded
                ? JSON.stringify(value)
                : '{...}'
              : String(value)}
        </span>

        {isFk && (
          <span className="ml-1 inline-flex shrink-0 items-center rounded border border-border bg-muted/40 px-1 py-0.5 text-[9px] text-muted-foreground">
            {colMeta.fk_table}
          </span>
        )}

        {(isJson || largeValue) && (
          <button
            type="button"
            className="ml-auto rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
            onClick={(e) => {
              e.stopPropagation()
              openLargeEditor()
            }}
            title="Open large editor"
          >
            <Expand className="h-3.5 w-3.5" />
          </button>
        )}

        {editMode && !rowDeleted && !isJson && !largeValue && (
          <button
            type="button"
            className="ml-auto rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
            onClick={(e) => {
              e.stopPropagation()
              startEdit()
            }}
            title="Edit value"
          >
            <Pencil className="h-3 w-3" />
          </button>
        )}
      </div>

      <LargeValueModal
        open={largeEditorOpen}
        title={`${colMeta.name} (${colMeta.data_type})`}
        initialValue={value}
        isJson={isJson}
        nullable={colMeta.nullable}
        onClose={() => setLargeEditorOpen(false)}
        onSave={(newValue) => {
          if (!editMode || rowDeleted) return
          onChange(newValue)
        }}
        onSetNull={() => {
          if (!editMode || rowDeleted || !colMeta.nullable) return
          onChange(null)
        }}
      />
    </>
  )
}
