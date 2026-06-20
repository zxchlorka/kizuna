import { useMemo, useState } from 'react'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useConnectionStore } from '@/stores/connections'
import { useLinksStore } from '@/stores/links'
import { useToastStore } from '@/stores/toast'
import type { LinkTargetKind } from '@/types/api'

interface CreateLinkDialogProps {
  open: boolean
  sourceConnId: string
  topic: string
  fieldOptions: string[]
  onOpenChange: (open: boolean) => void
}

export function CreateLinkDialog({ open, sourceConnId, topic, fieldOptions, onOpenChange }: CreateLinkDialogProps) {
  const connections = useConnectionStore((state) => state.connections)
  const createLink = useLinksStore((state) => state.create)
  const pushToast = useToastStore((state) => state.push)

  const [field, setField] = useState('')
  const [targetConnId, setTargetConnId] = useState('')
  const [keyPattern, setKeyPattern] = useState('')
  const [table, setTable] = useState('')
  const [column, setColumn] = useState('')
  const [saving, setSaving] = useState(false)

  const targetConn = connections.find((conn) => conn.id === targetConnId)
  const targetKind: LinkTargetKind | null =
    targetConn?.type === 'redis' ? 'redis' : targetConn?.type === 'postgres' ? 'postgres' : null

  const targetOptions = useMemo(
    () => connections.filter((conn) => conn.type === 'redis' || conn.type === 'postgres'),
    [connections]
  )

  const reset = () => {
    setField('')
    setTargetConnId('')
    setKeyPattern('')
    setTable('')
    setColumn('')
  }

  const handleSave = async () => {
    if (!field || !targetKind) {
      return
    }
    setSaving(true)
    try {
      await createLink({
        source_conn_id: sourceConnId,
        topic,
        field,
        target_conn_id: targetConnId,
        target_kind: targetKind,
        key_pattern: targetKind === 'redis' ? keyPattern : undefined,
        table: targetKind === 'postgres' ? table : undefined,
        column: targetKind === 'postgres' ? column : undefined,
      })
      pushToast({ tone: 'success', title: 'Link created' })
      reset()
      onOpenChange(false)
    } catch (error) {
      pushToast({ tone: 'error', title: 'Failed to create link', message: (error as Error).message })
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create link from {topic}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1">
            <label className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground">Source field</label>
            <Select value={field} onValueChange={setField}>
              <SelectTrigger className="h-8 font-mono text-xs">
                <SelectValue placeholder="Pick a JSON field" />
              </SelectTrigger>
              <SelectContent>
                {fieldOptions.map((option) => (
                  <SelectItem key={option} value={option} className="font-mono text-xs">
                    {option}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1">
            <label className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground">Target connection</label>
            <Select value={targetConnId} onValueChange={setTargetConnId}>
              <SelectTrigger className="h-8 font-mono text-xs">
                <SelectValue placeholder="Pick redis/postgres connection" />
              </SelectTrigger>
              <SelectContent>
                {targetOptions.map((conn) => (
                  <SelectItem key={conn.id} value={conn.id} className="font-mono text-xs">
                    {conn.name} ({conn.type})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {targetKind === 'redis' && (
            <div className="space-y-1">
              <label className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground">Key pattern (one *)</label>
              <input
                value={keyPattern}
                onChange={(event) => setKeyPattern(event.target.value)}
                placeholder="w:*"
                className="h-8 w-full rounded-sm border border-border bg-background px-2 font-mono text-xs outline-none focus:border-orange-500/50"
              />
            </div>
          )}

          {targetKind === 'postgres' && (
            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-1">
                <label className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground">Table</label>
                <input
                  value={table}
                  onChange={(event) => setTable(event.target.value)}
                  placeholder="public.users"
                  className="h-8 w-full rounded-sm border border-border bg-background px-2 font-mono text-xs outline-none focus:border-orange-500/50"
                />
              </div>
              <div className="space-y-1">
                <label className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground">Column</label>
                <input
                  value={column}
                  onChange={(event) => setColumn(event.target.value)}
                  placeholder="id"
                  className="h-8 w-full rounded-sm border border-border bg-background px-2 font-mono text-xs outline-none focus:border-orange-500/50"
                />
              </div>
            </div>
          )}

          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button
              type="button"
              size="sm"
              disabled={
                saving ||
                !field ||
                !targetKind ||
                (targetKind === 'redis' && !keyPattern.includes('*')) ||
                (targetKind === 'postgres' && (!table || !column))
              }
              onClick={() => void handleSave()}
            >
              Save
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
