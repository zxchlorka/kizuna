import { useEffect, useState } from 'react'
import { X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { formatJson } from '@/lib/json'

interface LargeValueModalProps {
  open: boolean
  title: string
  initialValue: unknown
  isJson: boolean
  nullable: boolean
  onClose: () => void
  onSave: (value: unknown) => void
  onSetNull: () => void
  readOnly?: boolean
}

function stringifyValue(value: unknown, isJson: boolean): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'object') return JSON.stringify(value, null, 2)
  // A json/jsonb column arrives as text (see the ::text cast in the Postgres
  // data path) so that large integers inside it survive the trip. Indent it
  // here rather than through a parse, for the same reason.
  if (isJson && typeof value === 'string') return formatJson(value) ?? value
  return String(value)
}

export function LargeValueModal({
  open,
  title,
  initialValue,
  isJson,
  nullable,
  onClose,
  onSave,
  onSetNull,
  readOnly = false,
}: LargeValueModalProps) {
  const [text, setText] = useState('')
  const [error, setError] = useState<string | null>(null)
  const helperText = readOnly
    ? null
    : 'Changes are staged here. Use Save all in the table toolbar to persist them.'

  useEffect(() => {
    if (open) {
      setText(stringifyValue(initialValue, isJson))
      setError(null)
    }
  }, [open, initialValue, isJson])

  if (!open) return null

  const handleSave = () => {
    // JSON goes to the API as the edited text, not as a re-serialized parse of
    // it: JSON.parse rounds any integer above 2^53, so saving a document that
    // holds an int64 id would silently rewrite that id. The backend's coerceJSON
    // validates a string and stores it verbatim, so the text is the exact thing
    // written. JSON.parse here only decides whether it is valid.
    if (isJson) {
      if (text.trim() === '') {
        setError('JSON value cannot be empty')
        return
      }
      try {
        JSON.parse(text)
      } catch {
        setError('Invalid JSON')
        return
      }
    }

    onSave(text)
    onClose()
  }

  const handleSetNull = () => {
    onSetNull()
    onClose()
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="flex h-[80vh] w-full max-w-5xl flex-col rounded-lg border border-border bg-background shadow-2xl">
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <div>
            <h3 className="text-sm font-semibold text-foreground">{title}</h3>
            <p className="text-xs text-muted-foreground">
              {readOnly ? (isJson ? 'JSON preview' : 'Text preview') : isJson ? 'JSON editor' : 'Text editor'}
            </p>
            {helperText && <p className="mt-1 text-xs text-muted-foreground">{helperText}</p>}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
            aria-label="Close editor"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex-1 p-4">
          <textarea
            value={text}
            readOnly={readOnly}
            onChange={(e) => {
              setText(e.target.value)
              setError(null)
            }}
            className="h-full w-full resize-none rounded-md border border-border bg-background px-3 py-2 text-sm font-mono text-foreground outline-none ring-ring/40 focus:ring-2 read-only:cursor-default read-only:bg-muted/15 read-only:text-muted-foreground read-only:ring-0"
            spellCheck={false}
          />
          {error && <p className="mt-2 text-xs text-destructive">{error}</p>}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-border px-4 py-3">
          {!readOnly && nullable && (
            <Button type="button" size="sm" variant="outline" onClick={handleSetNull}>
              Set NULL
            </Button>
          )}
          <Button type="button" size="sm" variant="outline" onClick={onClose}>
            {readOnly ? 'Close' : 'Cancel'}
          </Button>
          {!readOnly && (
            <Button type="button" size="sm" onClick={handleSave}>
              Apply
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}
