import { useEffect, useState } from 'react'
import { Braces, PencilLine, RotateCcw, Save } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { tryParseJson } from '@/components/redis/redisUtils'

interface StringEditorProps {
  value: string
  isJson: boolean
  saving: boolean
  readOnly?: boolean
  onSave: (value: string) => Promise<void> | void
}

export function StringEditor({ value, isJson, saving, readOnly = false, onSave }: StringEditorProps) {
  const [draft, setDraft] = useState(value)
  const [editing, setEditing] = useState(false)
  const [pretty, setPretty] = useState(isJson)

  useEffect(() => {
    if (!editing) {
      setDraft(value)
    }
  }, [editing, value])

  const parsed = tryParseJson(draft)
  const effectiveValue = pretty && parsed.isJson ? parsed.text : draft

  const handleSave = async () => {
    await onSave(effectiveValue)
    setEditing(false)
  }

  return (
    <div className="rounded-sm border border-border bg-card">
      <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
        <div>
          <div className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground">String value</div>
          <div className="mt-1 text-sm text-muted-foreground">
            {isJson ? 'JSON detected. You can pretty-print before saving.' : 'Raw string payload.'}
          </div>
        </div>

        <div className="flex items-center gap-2">
          {isJson && (
            <Button type="button" variant="outline" size="sm" className="h-8 gap-1.5" onClick={() => setPretty((current) => !current)}>
              <Braces className="h-3.5 w-3.5" />
              {pretty ? 'Raw' : 'Pretty'}
            </Button>
          )}
          {editing ? (
            <>
              <Button type="button" variant="outline" size="sm" className="h-8 gap-1.5" onClick={() => {
                setDraft(value)
                setEditing(false)
              }}>
                <RotateCcw className="h-3.5 w-3.5" />
                Cancel
              </Button>
              <Button type="button" size="sm" className="h-8 gap-1.5" onClick={() => void handleSave()} disabled={saving}>
                <Save className="h-3.5 w-3.5" />
                {saving ? 'Saving…' : 'Save'}
              </Button>
            </>
          ) : readOnly ? null : (
            <Button type="button" variant="outline" size="sm" className="h-8 gap-1.5" onClick={() => setEditing(true)}>
              <PencilLine className="h-3.5 w-3.5" />
              Edit
            </Button>
          )}
        </div>
      </div>

      <div className="p-4">
        <Textarea
          value={effectiveValue}
          onChange={(event) => {
            setDraft(event.target.value)
            setPretty(false)
          }}
          readOnly={!editing}
          className="min-h-[360px] resize-y font-mono text-xs"
        />
      </div>
    </div>
  )
}
