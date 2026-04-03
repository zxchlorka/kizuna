import { useMemo, useState } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { Plus, Trash2, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import type { DDLColumnInput } from '@/types/api'

interface CreateTableFormProps {
  open: boolean
  schema: string
  saving: boolean
  onOpenChange: (open: boolean) => void
  onSubmit: (payload: { object: string; columns: DDLColumnInput[] }) => Promise<void> | void
}

const COLUMN_TYPES = ['integer', 'bigint', 'text', 'varchar(255)', 'boolean', 'timestamp', 'timestamptz', 'uuid', 'jsonb', 'decimal(10,2)']

const initialColumn = (): DDLColumnInput => ({
  name: '',
  type: 'text',
  nullable: true,
  primary_key: false,
  default: '',
})

export function CreateTableForm({ open, schema, saving, onOpenChange, onSubmit }: CreateTableFormProps) {
  const [tableName, setTableName] = useState('')
  const [columns, setColumns] = useState<DDLColumnInput[]>([initialColumn()])
  const [error, setError] = useState<string | null>(null)

  const reset = () => {
    setTableName('')
    setColumns([initialColumn()])
    setError(null)
  }

  const preview = useMemo(() => {
    const visibleColumns = columns.filter((column) => column.name.trim() !== '')
    if (tableName.trim() === '' || visibleColumns.length === 0) {
      return `CREATE TABLE "${schema}"."new_table" (...)`
    }
    const defs = visibleColumns.map((column) => {
      const parts = [`"${column.name}"`, column.type]
      if (!column.nullable || column.primary_key) parts.push('NOT NULL')
      const defaultValue = typeof column.default === 'string' ? column.default.trim() : column.default
      if (defaultValue) parts.push(`DEFAULT ${String(defaultValue)}`)
      return parts.join(' ')
    })
    const primaryKeys = visibleColumns.filter((column) => column.primary_key).map((column) => `"${column.name}"`)
    if (primaryKeys.length > 0) {
      defs.push(`PRIMARY KEY (${primaryKeys.join(', ')})`)
    }
    return `CREATE TABLE "${schema}"."${tableName.trim()}" (\n  ${defs.join(',\n  ')}\n)`
  }, [columns, schema, tableName])

  const updateColumn = (index: number, patch: Partial<DDLColumnInput>) => {
    setColumns((current) => current.map((column, columnIndex) => (columnIndex === index ? { ...column, ...patch } : column)))
  }

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault()
    const object = tableName.trim()
    const cleanedColumns = columns
      .map((column) => ({ ...column, name: column.name.trim(), default: typeof column.default === 'string' ? column.default.trim() : column.default }))
      .filter((column) => column.name !== '')

    if (!object) {
      setError('Table name is required.')
      return
    }
    if (cleanedColumns.length === 0) {
      setError('Add at least one column.')
      return
    }
    setError(null)
    try {
      await onSubmit({ object, columns: cleanedColumns })
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
        <Dialog.Content className="fixed inset-0 z-50 m-auto h-fit max-h-[calc(100vh-2rem)] w-full max-w-4xl overflow-y-auto rounded-sm border border-border bg-background shadow-2xl">
          <form onSubmit={handleSubmit}>
            <div className="flex items-center justify-between border-b border-border px-6 py-4">
              <div>
                <Dialog.Title className="font-mono text-sm font-semibold">Create Table</Dialog.Title>
                <p className="mt-1 text-xs text-muted-foreground">Schema: {schema}</p>
              </div>
              <Dialog.Close className="rounded-sm p-1 text-muted-foreground hover:bg-muted hover:text-foreground">
                <X className="h-4 w-4" />
              </Dialog.Close>
            </div>

            <div className="space-y-5 px-6 py-5">
              <div>
                <label className="mb-1 block text-[10px] uppercase tracking-[0.12em] text-muted-foreground">Table name</label>
                <input className="w-full rounded-sm border border-input bg-background px-3 py-2 text-sm font-mono outline-none focus:border-amber-500/60" value={tableName} onChange={(event) => setTableName(event.target.value)} placeholder="events_archive" />
              </div>

              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <p className="text-xs font-medium text-foreground">Columns</p>
                  <Button type="button" size="sm" variant="outline" className="h-8 gap-1.5 font-mono text-xs" onClick={() => setColumns((current) => [...current, initialColumn()])}>
                    <Plus className="h-3.5 w-3.5" />
                    Add Column
                  </Button>
                </div>

                <div className="space-y-3">
                  {columns.map((column, index) => (
                    <div key={index} className="grid gap-3 rounded-sm border border-border bg-muted/10 p-3 md:grid-cols-[1.4fr_1fr_0.8fr_0.8fr_1fr_auto]">
                      <div>
                        <label className="mb-1 block text-[10px] uppercase tracking-[0.12em] text-muted-foreground">Name</label>
                        <input className="w-full rounded-sm border border-input bg-background px-3 py-2 text-sm font-mono outline-none focus:border-amber-500/60" value={column.name} onChange={(event) => updateColumn(index, { name: event.target.value })} placeholder="id" />
                      </div>
                      <div>
                        <label className="mb-1 block text-[10px] uppercase tracking-[0.12em] text-muted-foreground">Type</label>
                        <Select value={column.type} onValueChange={(value) => updateColumn(index, { type: value })}>
                          <SelectTrigger className="h-10 w-full text-xs">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {COLUMN_TYPES.map((type) => (
                              <SelectItem key={type} value={type}>
                                {type}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                      <div>
                        <label className="mb-1 block text-[10px] uppercase tracking-[0.12em] text-muted-foreground">Nullable</label>
                        <button type="button" className="flex h-10 w-full items-center justify-center rounded-sm border border-input bg-background text-xs font-mono hover:border-amber-500/50" onClick={() => updateColumn(index, { nullable: !column.nullable })}>
                          {column.nullable ? 'YES' : 'NO'}
                        </button>
                      </div>
                      <div>
                        <label className="mb-1 block text-[10px] uppercase tracking-[0.12em] text-muted-foreground">Primary key</label>
                        <button type="button" className="flex h-10 w-full items-center justify-center rounded-sm border border-input bg-background text-xs font-mono hover:border-amber-500/50" onClick={() => updateColumn(index, { primary_key: !column.primary_key, nullable: column.primary_key ? column.nullable : false })}>
                          {column.primary_key ? 'PK' : 'No'}
                        </button>
                      </div>
                      <div>
                        <label className="mb-1 block text-[10px] uppercase tracking-[0.12em] text-muted-foreground">Default</label>
                        <input className="w-full rounded-sm border border-input bg-background px-3 py-2 text-sm font-mono outline-none focus:border-amber-500/60" value={typeof column.default === 'string' ? column.default : ''} onChange={(event) => updateColumn(index, { default: event.target.value })} placeholder="CURRENT_TIMESTAMP" />
                      </div>
                      <div className="flex items-end justify-end">
                        <Button type="button" size="sm" variant="outline" className="h-10 px-3" onClick={() => setColumns((current) => current.filter((_, columnIndex) => columnIndex !== index))} disabled={columns.length === 1}>
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
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
                {saving ? 'Creating…' : 'Create'}
              </Button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
