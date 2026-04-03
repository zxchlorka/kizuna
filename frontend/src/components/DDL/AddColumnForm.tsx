import { useState } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'

interface AddColumnFormProps {
  open: boolean
  tableName: string
  saving: boolean
  onOpenChange: (open: boolean) => void
  onSubmit: (payload: { name: string; type: string; nullable: boolean; default?: string }) => Promise<void> | void
}

const COLUMN_TYPES = ['integer', 'bigint', 'text', 'varchar(255)', 'boolean', 'timestamp', 'timestamptz', 'uuid', 'jsonb', 'decimal(10,2)']

export function AddColumnForm({ open, tableName, saving, onOpenChange, onSubmit }: AddColumnFormProps) {
  const [name, setName] = useState('')
  const [type, setType] = useState('text')
  const [nullable, setNullable] = useState(true)
  const [defaultValue, setDefaultValue] = useState('')
  const [error, setError] = useState<string | null>(null)

  const reset = () => {
    setName('')
    setType('text')
    setNullable(true)
    setDefaultValue('')
    setError(null)
  }

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!name.trim()) {
      setError('Column name is required.')
      return
    }
    setError(null)
    try {
      await onSubmit({
        name: name.trim(),
        type,
        nullable,
        default: defaultValue.trim() || undefined,
      })
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
                <Dialog.Title className="font-mono text-sm font-semibold">Add Column</Dialog.Title>
                <p className="mt-1 text-xs text-muted-foreground">Table: {tableName}</p>
              </div>
              <Dialog.Close className="rounded-sm p-1 text-muted-foreground hover:bg-muted hover:text-foreground">
                <X className="h-4 w-4" />
              </Dialog.Close>
            </div>
            <div className="space-y-4 px-6 py-5">
              <div>
                <label className="mb-1 block text-[10px] uppercase tracking-[0.12em] text-muted-foreground">Column name</label>
                <input className="w-full rounded-sm border border-input bg-background px-3 py-2 text-sm font-mono outline-none focus:border-amber-500/60" value={name} onChange={(event) => setName(event.target.value)} placeholder="created_by" />
              </div>
              <div>
                <label className="mb-1 block text-[10px] uppercase tracking-[0.12em] text-muted-foreground">Type</label>
                <Select value={type} onValueChange={setType}>
                  <SelectTrigger className="h-10 w-full text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {COLUMN_TYPES.map((item) => (
                      <SelectItem key={item} value={item}>
                        {item}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="grid gap-3 md:grid-cols-2">
                <div>
                  <label className="mb-1 block text-[10px] uppercase tracking-[0.12em] text-muted-foreground">Nullable</label>
                  <button type="button" className="flex h-10 w-full items-center justify-center rounded-sm border border-input bg-background text-xs font-mono hover:border-amber-500/50" onClick={() => setNullable((current) => !current)}>
                    {nullable ? 'YES' : 'NO'}
                  </button>
                </div>
                <div>
                  <label className="mb-1 block text-[10px] uppercase tracking-[0.12em] text-muted-foreground">Default</label>
                  <input className="w-full rounded-sm border border-input bg-background px-3 py-2 text-sm font-mono outline-none focus:border-amber-500/60" value={defaultValue} onChange={(event) => setDefaultValue(event.target.value)} placeholder="false" />
                </div>
              </div>
              {error && <p className="text-xs text-destructive">{error}</p>}
            </div>
            <div className="flex items-center justify-end gap-2 border-t border-border px-6 py-4">
              <Button type="button" variant="outline" size="sm" className="h-8 px-3" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button type="submit" size="sm" className="h-8 px-3" disabled={saving}>
                {saving ? 'Adding…' : 'Add Column'}
              </Button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
