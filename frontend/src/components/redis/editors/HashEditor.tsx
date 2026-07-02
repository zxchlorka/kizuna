import { useState, type MouseEvent } from 'react'
import { Plus, Save, Trash2, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import type { TableRow } from '@/types/api'

interface HashEditorProps {
  rows: TableRow[]
  saving: boolean
  readOnly?: boolean
  onUpdate: (field: string, value: string) => Promise<void> | void
  onDelete: (field: string) => Promise<void> | void
  onInsert: (field: string, value: string) => Promise<void> | void
  onElementContextMenu?: (value: string, event: MouseEvent) => void
}

export function HashEditor({ rows, saving, readOnly = false, onUpdate, onDelete, onInsert, onElementContextMenu }: HashEditorProps) {
  const [editingField, setEditingField] = useState<string | null>(null)
  const [draftValue, setDraftValue] = useState('')
  const [newField, setNewField] = useState('')
  const [newValue, setNewValue] = useState('')

  return (
    <div className="rounded-sm border border-border bg-card">
      <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
        <div>
          <div className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground">Hash fields</div>
          <div className="mt-1 text-sm text-muted-foreground">
            {readOnly ? 'Read-only connection.' : 'Double-click a value to edit it inline.'}
          </div>
        </div>

        {!readOnly && (
          <div className="flex items-center gap-2">
            <Input value={newField} onChange={(event) => setNewField(event.target.value)} placeholder="field" className="h-8 w-36 font-mono text-xs" />
            <Input value={newValue} onChange={(event) => setNewValue(event.target.value)} placeholder="value" className="h-8 w-48 font-mono text-xs" />
            <Button
              type="button"
              size="sm"
              className="h-8 gap-1.5"
              disabled={saving || newField.trim() === ''}
              onClick={() => void onInsert(newField.trim(), newValue)}
            >
              <Plus className="h-3.5 w-3.5" />
              Add field
            </Button>
          </div>
        )}
      </div>

      <div className="overflow-x-auto">
        <table className="min-w-full divide-y divide-border text-sm">
          <thead className="bg-muted/30 text-left text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
            <tr>
              <th className="px-4 py-3 font-medium">Field</th>
              <th className="px-4 py-3 font-medium">Value</th>
              <th className="px-4 py-3 font-medium text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border/70">
            {rows.map((row, index) => {
              const field = String(row.field ?? `field-${index}`)
              const value = String(row.value ?? '')
              const editing = editingField === field
              return (
                <tr key={field} className="align-top" onContextMenu={onElementContextMenu ? (event) => onElementContextMenu(value, event) : undefined}>
                  <td className="px-4 py-3 font-mono text-xs text-foreground">{field}</td>
                  <td
                    className="px-4 py-3 font-mono text-xs text-foreground"
                    onDoubleClick={() => {
                      if (readOnly) {
                        return
                      }
                      setEditingField(field)
                      setDraftValue(value)
                    }}
                  >
                    {editing ? (
                      <Input value={draftValue} onChange={(event) => setDraftValue(event.target.value)} className="h-8 font-mono text-xs" />
                    ) : (
                      <div className="whitespace-pre-wrap break-all">{value || <span className="text-muted-foreground">empty</span>}</div>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    {readOnly ? (
                      <div className="text-right text-[10px] uppercase tracking-[0.12em] text-muted-foreground">—</div>
                    ) : (
                      <div className="flex justify-end gap-2">
                        {editing ? (
                          <>
                            <Button type="button" size="icon" variant="outline" className="h-8 w-8" onClick={() => void Promise.resolve(onUpdate(field, draftValue)).then(() => setEditingField(null))} disabled={saving}>
                              <Save className="h-3.5 w-3.5" />
                            </Button>
                            <Button type="button" size="icon" variant="outline" className="h-8 w-8" onClick={() => setEditingField(null)}>
                              <X className="h-3.5 w-3.5" />
                            </Button>
                          </>
                        ) : null}
                        <Button type="button" size="icon" variant="outline" className="h-8 w-8 text-destructive" onClick={() => void onDelete(field)} disabled={saving}>
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}
