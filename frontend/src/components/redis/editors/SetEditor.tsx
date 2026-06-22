import { useMemo, useState, type MouseEvent } from 'react'
import { Plus, Search, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import type { TableRow } from '@/types/api'

interface SetEditorProps {
  rows: TableRow[]
  saving: boolean
  readOnly?: boolean
  onInsert: (member: string) => Promise<void> | void
  onDelete: (member: string) => Promise<void> | void
  onElementContextMenu?: (value: string, event: MouseEvent) => void
}

export function SetEditor({ rows, saving, readOnly = false, onInsert, onDelete, onElementContextMenu }: SetEditorProps) {
  const [search, setSearch] = useState('')
  const [newMember, setNewMember] = useState('')

  const filteredRows = useMemo(() => {
    const query = search.trim().toLowerCase()
    if (!query) return rows
    return rows.filter((row) => String(row.member ?? '').toLowerCase().includes(query))
  }, [rows, search])

  return (
    <div className="rounded-sm border border-border bg-card">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3">
        <div>
          <div className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground">Set members</div>
          <div className="mt-1 text-sm text-muted-foreground">Searchable member list with single-click removal.</div>
        </div>

        <div className="flex items-center gap-2">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search members" className="h-8 w-48 pl-8 font-mono text-xs" />
          </div>
          {!readOnly && (
            <>
              <Input value={newMember} onChange={(event) => setNewMember(event.target.value)} placeholder="new member" className="h-8 w-48 font-mono text-xs" />
              <Button type="button" size="sm" className="h-8 gap-1.5" disabled={saving || newMember.trim() === ''} onClick={() => void onInsert(newMember.trim())}>
                <Plus className="h-3.5 w-3.5" />
                Add
              </Button>
            </>
          )}
        </div>
      </div>

      <div className="grid gap-2 p-4 md:grid-cols-2 xl:grid-cols-3">
        {filteredRows.map((row, index) => {
          const member = String(row.member ?? `member-${index}`)
          return (
            <div
              key={member}
              className="flex items-center gap-2 rounded-sm border border-border bg-background px-3 py-2"
              onContextMenu={onElementContextMenu ? (event) => onElementContextMenu(member, event) : undefined}
            >
              <div className="min-w-0 flex-1 font-mono text-xs text-foreground">{member}</div>
              {!readOnly && (
                <Button type="button" size="icon" variant="outline" className="h-7 w-7 text-destructive" onClick={() => void onDelete(member)} disabled={saving}>
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
