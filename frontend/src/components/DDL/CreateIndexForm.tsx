import { useMemo, useState } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import type { ColumnMeta } from '@/types/api'

interface CreateIndexFormProps {
  open: boolean
  tableName: string
  columns: ColumnMeta[]
  saving: boolean
  onOpenChange: (open: boolean) => void
  onSubmit: (payload: { name: string; columns: string[]; unique: boolean }) => Promise<void> | void
}

export function CreateIndexForm({ open, tableName, columns, saving, onOpenChange, onSubmit }: CreateIndexFormProps) {
  const [name, setName] = useState('')
  const [selectedColumns, setSelectedColumns] = useState<string[]>([])
  const [unique, setUnique] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const preview = useMemo(() => {
    if (!name.trim() || selectedColumns.length === 0) {
      return `CREATE INDEX idx_${tableName}_col ON "${tableName}" (...)`
    }
    const prefix = unique ? 'CREATE UNIQUE INDEX' : 'CREATE INDEX'
    return `${prefix} "${name.trim()}" ON "${tableName}" (${selectedColumns.map((column) => `"${column}"`).join(', ')})`
  }, [name, selectedColumns, tableName, unique])

  const reset = () => {
    setName('')
    setSelectedColumns([])
    setUnique(false)
    setError(null)
  }

  const toggleColumn = (columnName: string) => {
    setSelectedColumns((current) =>
      current.includes(columnName) ? current.filter((item) => item !== columnName) : [...current, columnName]
    )
  }

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!name.trim()) {
      setError('Index name is required.')
      return
    }
    if (selectedColumns.length === 0) {
      setError('Select at least one column.')
      return
    }
    setError(null)
    try {
      await onSubmit({ name: name.trim(), columns: selectedColumns, unique })
      reset()
    } catch (submitError) {
      setError((submitError as Error).message)
    }
  }

  return (
    <Dialog.Root open={open} onOpenChange={(next) => {
      onOpenChange(next)
      if (!next) reset()
    }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/60" />
        <Dialog.Content className="fixed inset-0 z-50 m-auto h-fit w-full max-w-xl rounded-sm border border-border bg-background shadow-2xl">
          <form onSubmit={handleSubmit}>
            <div className="flex items-center justify-between border-b border-border px-6 py-4">
              <div>
                <Dialog.Title className="font-mono text-sm font-semibold">Create Index</Dialog.Title>
                <p className="mt-1 text-xs text-muted-foreground">Table: {tableName}</p>
              </div>
              <Dialog.Close className="rounded-sm p-1 text-muted-foreground hover:bg-muted hover:text-foreground">
                <X className="h-4 w-4" />
              </Dialog.Close>
            </div>
            <div className="space-y-4 px-6 py-5">
              <div>
                <label className="mb-1 block text-[10px] uppercase tracking-[0.12em] text-muted-foreground">Index name</label>
                <input className="w-full rounded-sm border border-input bg-background px-3 py-2 text-sm font-mono outline-none focus:border-amber-500/60" value={name} onChange={(event) => setName(event.target.value)} placeholder={`idx_${tableName}_lookup`} />
              </div>
              <div>
                <label className="mb-2 block text-[10px] uppercase tracking-[0.12em] text-muted-foreground">Columns</label>
                <div className="max-h-52 space-y-2 overflow-y-auto rounded-sm border border-border bg-muted/10 p-3">
                  {columns.map((column) => (
                    <label key={column.name} className="flex items-center justify-between rounded-sm border border-border/70 bg-background px-3 py-2 text-sm">
                      <span className="font-mono">{column.name}</span>
                      <input type="checkbox" checked={selectedColumns.includes(column.name)} onChange={() => toggleColumn(column.name)} />
                    </label>
                  ))}
                </div>
              </div>
              <div>
                <label className="mb-1 block text-[10px] uppercase tracking-[0.12em] text-muted-foreground">Unique</label>
                <button type="button" className="flex h-10 w-full items-center justify-center rounded-sm border border-input bg-background text-xs font-mono hover:border-amber-500/50" onClick={() => setUnique((current) => !current)}>
                  {unique ? 'UNIQUE' : 'REGULAR'}
                </button>
              </div>
              <div className="rounded-sm border border-border bg-card p-4">
                <p className="mb-2 text-[10px] uppercase tracking-[0.12em] text-muted-foreground">SQL Preview</p>
                <pre className="overflow-x-auto whitespace-pre-wrap font-mono text-xs text-foreground">{preview}</pre>
              </div>
              {error && <p className="text-xs text-destructive">{error}</p>}
            </div>
            <div className="flex items-center justify-end gap-2 border-t border-border px-6 py-4">
              <Button type="button" variant="outline" size="sm" className="h-8 px-3" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button type="submit" size="sm" className="h-8 px-3" disabled={saving}>
                {saving ? 'Creating…' : 'Create Index'}
              </Button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
