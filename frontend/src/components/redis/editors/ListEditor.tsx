import { useState, type MouseEvent } from 'react'
import { ChevronLeft, ChevronRight, Plus, Save, Trash2, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import type { TableRow } from '@/types/api'

interface ListEditorProps {
  rows: TableRow[]
  saving: boolean
  readOnly?: boolean
  offset: number
  limit: number
  total: number
  onUpdate: (index: number, value: string) => Promise<void> | void
  onDelete: (index: number) => Promise<void> | void
  onInsert: (value: string, direction: 'left' | 'right') => Promise<void> | void
  onNext: () => void
  onPrev: () => void
  onElementContextMenu?: (value: string, event: MouseEvent) => void
}

export function ListEditor({
  rows,
  saving,
  readOnly = false,
  offset,
  limit,
  total,
  onUpdate,
  onDelete,
  onInsert,
  onNext,
  onPrev,
  onElementContextMenu,
}: ListEditorProps) {
  const [editingIndex, setEditingIndex] = useState<number | null>(null)
  const [draftValue, setDraftValue] = useState('')
  const [newValue, setNewValue] = useState('')
  const [direction, setDirection] = useState<'left' | 'right'>('right')

  return (
    <div className="rounded-sm border border-border bg-card">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3">
        <div>
          <div className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground">List items</div>
          <div className="mt-1 text-sm text-muted-foreground">Paged view with directional inserts.</div>
        </div>

        {!readOnly && (
          <div className="flex items-center gap-2">
            <Textarea value={newValue} onChange={(event) => setNewValue(event.target.value)} placeholder="New item" className="min-h-8 w-64 font-mono text-xs" />
            <Button type="button" variant={direction === 'left' ? 'secondary' : 'outline'} size="sm" className="h-8" onClick={() => setDirection('left')}>
              LPUSH
            </Button>
            <Button type="button" variant={direction === 'right' ? 'secondary' : 'outline'} size="sm" className="h-8" onClick={() => setDirection('right')}>
              RPUSH
            </Button>
            <Button type="button" size="sm" className="h-8 gap-1.5" disabled={saving || newValue.trim() === ''} onClick={() => void onInsert(newValue, direction)}>
              <Plus className="h-3.5 w-3.5" />
              Add item
            </Button>
          </div>
        )}
      </div>

      <div className="overflow-x-auto">
        <table className="min-w-full divide-y divide-border text-sm">
          <thead className="bg-muted/30 text-left text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
            <tr>
              <th className="px-4 py-3 font-medium">Index</th>
              <th className="px-4 py-3 font-medium">Value</th>
              <th className="px-4 py-3 font-medium text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border/70">
            {rows.map((row, rowIndex) => {
              const index = Number(row.index ?? rowIndex)
              const value = String(row.value ?? '')
              const editing = editingIndex === index
              return (
                <tr key={`list-${index}`} className="align-top" onContextMenu={onElementContextMenu ? (event) => onElementContextMenu(value, event) : undefined}>
                  <td className="px-4 py-3 font-mono text-xs text-muted-foreground">{index}</td>
                  <td
                    className="px-4 py-3 font-mono text-xs text-foreground"
                    onDoubleClick={() => {
                      if (readOnly) {
                        return
                      }
                      setEditingIndex(index)
                      setDraftValue(value)
                    }}
                  >
                    {editing ? (
                      <Input value={draftValue} onChange={(event) => setDraftValue(event.target.value)} className="h-8 font-mono text-xs" />
                    ) : (
                      <div className="whitespace-pre-wrap break-all">{value}</div>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    {readOnly ? (
                      <div className="text-right text-[10px] uppercase tracking-[0.12em] text-muted-foreground">—</div>
                    ) : (
                      <div className="flex justify-end gap-2">
                        {editing ? (
                          <>
                            <Button type="button" size="icon" variant="outline" className="h-8 w-8" onClick={() => void Promise.resolve(onUpdate(index, draftValue)).then(() => setEditingIndex(null))} disabled={saving}>
                              <Save className="h-3.5 w-3.5" />
                            </Button>
                            <Button type="button" size="icon" variant="outline" className="h-8 w-8" onClick={() => setEditingIndex(null)}>
                              <X className="h-3.5 w-3.5" />
                            </Button>
                          </>
                        ) : null}
                        <Button type="button" size="icon" variant="outline" className="h-8 w-8 text-destructive" onClick={() => void onDelete(index)} disabled={saving}>
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

      <div className="flex items-center justify-between border-t border-border px-4 py-3 text-xs text-muted-foreground">
        <span>
          Showing {Math.min(total, offset + 1)}-{Math.min(total, offset + rows.length)} of {total}
        </span>
        <div className="flex items-center gap-2">
          <Button type="button" variant="outline" size="sm" className="h-8 gap-1.5" onClick={onPrev} disabled={offset === 0 || saving}>
            <ChevronLeft className="h-3.5 w-3.5" />
            Prev
          </Button>
          <Button type="button" variant="outline" size="sm" className="h-8 gap-1.5" onClick={onNext} disabled={offset + limit >= total || saving}>
            Next
            <ChevronRight className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>
    </div>
  )
}
