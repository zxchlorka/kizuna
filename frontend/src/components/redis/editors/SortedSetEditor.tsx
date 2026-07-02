import { useMemo, useState, type MouseEvent } from 'react'
import { ArrowDownUp, Plus, Save, Trash2, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import type { TableRow } from '@/types/api'

interface SortedSetEditorProps {
  rows: TableRow[]
  saving: boolean
  readOnly?: boolean
  onUpdateScore: (member: string, score: number) => Promise<void> | void
  onDelete: (member: string) => Promise<void> | void
  onInsert: (member: string, score: number) => Promise<void> | void
  onElementContextMenu?: (value: string, event: MouseEvent) => void
}

type SortKey = 'score' | 'member'

export function SortedSetEditor({ rows, saving, readOnly = false, onUpdateScore, onDelete, onInsert, onElementContextMenu }: SortedSetEditorProps) {
  const [sortKey, setSortKey] = useState<SortKey>('score')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc')
  const [editingMember, setEditingMember] = useState<string | null>(null)
  const [draftScore, setDraftScore] = useState('')
  const [newMember, setNewMember] = useState('')
  const [newScore, setNewScore] = useState('0')

  const sortedRows = useMemo(() => {
    const next = [...rows]
    next.sort((left, right) => {
      if (sortKey === 'member') {
        const a = String(left.member ?? '')
        const b = String(right.member ?? '')
        return sortDir === 'asc' ? a.localeCompare(b) : b.localeCompare(a)
      }
      const a = Number(left.score ?? 0)
      const b = Number(right.score ?? 0)
      return sortDir === 'asc' ? a - b : b - a
    })
    return next
  }, [rows, sortDir, sortKey])

  return (
    <div className="rounded-sm border border-border bg-card">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3">
        <div>
          <div className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground">Sorted set</div>
          <div className="mt-1 text-sm text-muted-foreground">Edit scores inline and sort by score or member.</div>
        </div>

        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-8 gap-1.5"
            onClick={() => {
              setSortKey((current) => (current === 'score' ? 'member' : 'score'))
              setSortDir('asc')
            }}
          >
            <ArrowDownUp className="h-3.5 w-3.5" />
            Sort: {sortKey}
          </Button>
          <Button type="button" variant="outline" size="sm" className="h-8" onClick={() => setSortDir((current) => (current === 'asc' ? 'desc' : 'asc'))}>
            {sortDir}
          </Button>
          {!readOnly && (
            <>
              <Input value={newMember} onChange={(event) => setNewMember(event.target.value)} placeholder="member" className="h-8 w-40 font-mono text-xs" />
              <Input value={newScore} onChange={(event) => setNewScore(event.target.value)} placeholder="score" className="h-8 w-24 font-mono text-xs" />
              <Button
                type="button"
                size="sm"
                className="h-8 gap-1.5"
                disabled={saving || newMember.trim() === '' || Number.isNaN(Number(newScore))}
                onClick={() => void onInsert(newMember.trim(), Number(newScore))}
              >
                <Plus className="h-3.5 w-3.5" />
                Add
              </Button>
            </>
          )}
        </div>
      </div>

      <div className="overflow-x-auto">
        <table className="min-w-full divide-y divide-border text-sm">
          <thead className="bg-muted/30 text-left text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
            <tr>
              <th className="px-4 py-3 font-medium">Score</th>
              <th className="px-4 py-3 font-medium">Member</th>
              <th className="px-4 py-3 font-medium text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border/70">
            {sortedRows.map((row, index) => {
              const member = String(row.member ?? `member-${index}`)
              const score = Number(row.score ?? 0)
              const editing = editingMember === member
              return (
                <tr key={member} onContextMenu={onElementContextMenu ? (event) => onElementContextMenu(member, event) : undefined}>
                  <td
                    className="px-4 py-3 font-mono text-xs text-foreground"
                    onDoubleClick={() => {
                      if (readOnly) {
                        return
                      }
                      setEditingMember(member)
                      setDraftScore(String(score))
                    }}
                  >
                    {editing ? (
                      <Input value={draftScore} onChange={(event) => setDraftScore(event.target.value)} className="h-8 w-24 font-mono text-xs" />
                    ) : (
                      score
                    )}
                  </td>
                  <td className="px-4 py-3 font-mono text-xs text-foreground">{member}</td>
                  <td className="px-4 py-3">
                    {readOnly ? (
                      <div className="text-right text-[10px] uppercase tracking-[0.12em] text-muted-foreground">—</div>
                    ) : (
                      <div className="flex justify-end gap-2">
                        {editing ? (
                          <>
                            <Button type="button" size="icon" variant="outline" className="h-8 w-8" disabled={saving || Number.isNaN(Number(draftScore))} onClick={() => void Promise.resolve(onUpdateScore(member, Number(draftScore))).then(() => setEditingMember(null))}>
                              <Save className="h-3.5 w-3.5" />
                            </Button>
                            <Button type="button" size="icon" variant="outline" className="h-8 w-8" onClick={() => setEditingMember(null)}>
                              <X className="h-3.5 w-3.5" />
                            </Button>
                          </>
                        ) : null}
                        <Button type="button" size="icon" variant="outline" className="h-8 w-8 text-destructive" onClick={() => void onDelete(member)} disabled={saving}>
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
