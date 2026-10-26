import { useEffect, useState } from 'react'
import { AlertTriangle, RotateCcw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { formatCompactCount, formatExactCount } from '@/lib/numberFormat'
import { cn } from '@/lib/utils'
import { useKafkaStore } from '@/stores/kafka'
import { useToastStore } from '@/stores/toast'
import type { KafkaOffsetResetMode, ObjectItem } from '@/types/api'

const MODES: { id: KafkaOffsetResetMode; label: string }[] = [
  { id: 'earliest', label: 'Earliest' },
  { id: 'latest', label: 'Latest' },
  { id: 'timestamp', label: 'Time' },
]

const metaNumber = (item: ObjectItem, key: string) => (typeof item.meta?.[key] === 'number' ? (item.meta[key] as number) : 0)

// What the reset does to the group, in messages, before anyone presses the button.
// Earliest and latest are fully known from the partition bounds; a time lands
// somewhere in between, and only the broker knows where.
export function resetConsequence(mode: KafkaOffsetResetMode, partitions: ObjectItem[], currentLag: number): string {
  if (mode === 'earliest') {
    const retained = partitions.reduce((sum, p) => sum + Math.max(0, metaNumber(p, 'end_offset') - metaNumber(p, 'start_offset')), 0)
    return retained === 0
      ? 'The topic holds no messages, so there is nothing to re-read.'
      : `The group will re-read ${formatCompactCount(retained)} messages from the start of the topic.`
  }
  if (mode === 'latest') {
    return currentLag === 0
      ? 'The group is already caught up; nothing will be skipped.'
      : `The group will skip ${formatCompactCount(currentLag)} unread messages.`
  }
  return 'The group will continue from the first message written at or after this time.'
}

interface KafkaResetOffsetsDialogProps {
  connId: string
  topic: string
  // null closes the dialog.
  group: ObjectItem | null
  partitions: ObjectItem[]
  production: boolean
  onOpenChange: (open: boolean) => void
  onReset: () => void
}

export function KafkaResetOffsetsDialog({ connId, topic, group, partitions, production, onOpenChange, onReset }: KafkaResetOffsetsDialogProps) {
  const resetGroupOffsets = useKafkaStore((state) => state.resetGroupOffsets)
  const pushToast = useToastStore((state) => state.push)
  const [mode, setMode] = useState<KafkaOffsetResetMode>('earliest')
  const [time, setTime] = useState('')
  const [typedName, setTypedName] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!group) {
      setMode('earliest')
      setTime('')
      setTypedName('')
    }
  }, [group])

  if (!group) return null

  const members = metaNumber(group, 'members')
  const timestamp = time ? new Date(time).getTime() : NaN
  const canReset =
    members === 0 &&
    (mode !== 'timestamp' || Number.isFinite(timestamp)) &&
    (!production || typedName.trim() === group.name) &&
    !saving

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!canReset) return
    setSaving(true)
    try {
      const result = await resetGroupOffsets(connId, {
        group: group.name,
        topic,
        mode,
        timestamp: mode === 'timestamp' ? timestamp : undefined,
      })
      pushToast({
        tone: 'success',
        title: 'Offsets reset',
        message: `${group.name} now starts from ${mode === 'timestamp' ? time.replace('T', ' ') : mode} on ${result.partitions.length} partitions of ${topic}`,
      })
      onReset()
      onOpenChange(false)
    } catch (error) {
      pushToast({ tone: 'error', title: 'Reset failed', message: (error as Error).message })
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <form onSubmit={handleSubmit} className="space-y-4">
          <DialogHeader>
            <DialogTitle className="font-mono text-sm">Reset offsets</DialogTitle>
            <DialogDescription className="text-xs">
              Moves <span className="font-mono text-foreground">{group.name}</span> on every partition of{' '}
              <span className="font-mono text-foreground">{topic}</span>.
            </DialogDescription>
          </DialogHeader>

          {members > 0 ? (
            <div className="flex gap-2 rounded-sm border border-amber-500/30 bg-amber-500/10 px-3 py-2.5 text-xs text-amber-600 dark:text-amber-400">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>
                {members} consumer{members === 1 ? ' is' : 's are'} still in this group. Kafka only accepts a reset while the group is
                empty, so stop them first and refresh.
              </span>
            </div>
          ) : (
            <>
              <div className="flex items-center gap-1 rounded-sm border border-border bg-muted/10 p-1" role="radiogroup" aria-label="Reset to">
                {MODES.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    role="radio"
                    aria-checked={mode === item.id}
                    onClick={() => setMode(item.id)}
                    className={cn(
                      'flex-1 rounded-sm px-3 py-1.5 font-mono text-xs transition-colors',
                      mode === item.id ? 'bg-orange-500/15 text-orange-600 dark:text-orange-400' : 'text-muted-foreground hover:text-foreground'
                    )}
                  >
                    {item.label}
                  </button>
                ))}
              </div>

              {mode === 'timestamp' && (
                <input
                  type="datetime-local"
                  value={time}
                  onChange={(event) => setTime(event.target.value)}
                  aria-label="Reset to time"
                  className="h-9 w-full rounded-sm border border-border bg-background px-2 font-mono text-xs outline-none focus:border-orange-500/50"
                />
              )}

              <p className="text-sm" title={`Current lag ${formatExactCount(group.row_count)}`}>
                {resetConsequence(mode, partitions, group.row_count)}
              </p>

              {production && (
                <div>
                  <label className="mb-1 block text-[10px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
                    Production connection. Type the group name to confirm
                  </label>
                  <Input
                    value={typedName}
                    onChange={(event) => setTypedName(event.target.value)}
                    placeholder={group.name}
                    spellCheck={false}
                    autoComplete="off"
                    className="font-mono text-xs focus:border-destructive/60"
                  />
                </div>
              )}
            </>
          )}

          <DialogFooter>
            <Button type="button" variant="outline" size="sm" className="h-8 px-3" onClick={() => onOpenChange(false)} disabled={saving}>
              Cancel
            </Button>
            <Button type="submit" size="sm" variant="destructive" className="h-8 gap-1.5 px-3" disabled={!canReset}>
              <RotateCcw className="h-3.5 w-3.5" />
              {saving ? 'Resetting…' : 'Reset offsets'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
