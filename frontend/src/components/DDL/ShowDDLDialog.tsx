import { useEffect, useRef, useState } from 'react'
import { Copy } from 'lucide-react'
import { defaultHighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { PostgreSQL, sql } from '@codemirror/lang-sql'
import { EditorState } from '@codemirror/state'
import { EditorView, lineNumbers } from '@codemirror/view'
import { useTheme } from 'next-themes'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { buildTheme } from '@/components/SqlConsole/SqlEditor'
import { clipboardFailureMessage, writeClipboardText } from '@/lib/clipboard'
import { fetchWithTimeout, throwOnApiError } from '@/lib/http'
import { useToastStore } from '@/stores/toast'

interface ShowDDLDialogProps {
  open: boolean
  connId: string
  object: string
  onOpenChange: (open: boolean) => void
}

export function ShowDDLDialog({ open, connId, object, onOpenChange }: ShowDDLDialogProps) {
  const [ddl, setDdl] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const pushToast = useToastStore((state) => state.push)

  // Fetched on every open: the point is the table as it is now, and a stale copy
  // after an Add Column in the same tab would be exactly the wrong answer.
  useEffect(() => {
    if (!open) return
    let canceled = false
    setDdl(null)
    setError(null)
    void (async () => {
      try {
        const res = await fetchWithTimeout(`/api/connections/${connId}/objects/${encodeURIComponent(object)}/ddl`)
        await throwOnApiError(res)
        const body = (await res.json()) as { ddl: string }
        if (!canceled) setDdl(body.ddl)
      } catch (err) {
        if (!canceled) setError((err as Error).message)
      }
    })()
    return () => {
      canceled = true
    }
  }, [open, connId, object])

  const handleCopy = async () => {
    if (!ddl) return
    if (await writeClipboardText(ddl)) {
      pushToast({ tone: 'success', title: 'DDL copied', message: `CREATE statement for ${object} copied to clipboard.` })
    } else {
      setError(clipboardFailureMessage())
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[calc(100vh-2rem)] max-w-4xl">
        <DialogHeader>
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <DialogTitle className="truncate font-mono text-sm">{object}</DialogTitle>
              <DialogDescription className="text-xs">The statement that recreates it, read from the catalog just now.</DialogDescription>
            </div>
            <Button variant="outline" size="sm" className="h-8 shrink-0 gap-1.5 px-2.5" onClick={() => void handleCopy()} disabled={!ddl}>
              <Copy className="h-3.5 w-3.5" />
              Copy
            </Button>
          </div>
        </DialogHeader>

        {error ? (
          <div className="rounded-sm border border-destructive/30 bg-destructive/10 px-3 py-2.5 text-xs text-destructive">{error}</div>
        ) : ddl === null ? (
          <div className="h-48 animate-pulse rounded-sm border border-border bg-muted/20" />
        ) : (
          <SqlView text={ddl} />
        )}
      </DialogContent>
    </Dialog>
  )
}

// Read-only CodeMirror so the DDL is coloured exactly like the SQL console.
function SqlView({ text }: { text: string }) {
  const rootRef = useRef<HTMLDivElement | null>(null)
  const { resolvedTheme } = useTheme()

  useEffect(() => {
    if (!rootRef.current) return
    const view = new EditorView({
      parent: rootRef.current,
      state: EditorState.create({
        doc: text,
        extensions: [
          sql({ dialect: PostgreSQL }),
          syntaxHighlighting(defaultHighlightStyle),
          lineNumbers(),
          EditorView.lineWrapping,
          EditorState.readOnly.of(true),
          EditorView.editable.of(false),
          buildTheme(resolvedTheme === 'dark'),
        ],
      }),
    })
    return () => view.destroy()
  }, [text, resolvedTheme])

  return <div ref={rootRef} className="max-h-[60vh] overflow-auto rounded-sm border border-border bg-background" />
}
