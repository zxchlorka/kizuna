import { useEffect, useMemo, useState } from 'react'
import { Clock3, TimerReset, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import { formatRedisTTL, toNumberOrNull } from '@/components/redis/redisUtils'

interface SetTTLDialogProps {
  open: boolean
  keyName: string
  currentTTL?: number | null
  saving: boolean
  onOpenChange: (open: boolean) => void
  onConfirm: (ttl: number) => Promise<void> | void
}

const PRESETS = [
  { label: '1h', value: 3600 },
  { label: '1d', value: 86400 },
  { label: '1w', value: 604800 },
]

export function SetTTLDialog({ open, keyName, currentTTL, saving, onOpenChange, onConfirm }: SetTTLDialogProps) {
  const [ttlText, setTtlText] = useState('')
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (open) {
      setTtlText(currentTTL && currentTTL > 0 ? String(currentTTL) : '')
      setError(null)
    }
  }, [currentTTL, open])

  const preview = useMemo(() => {
    const parsed = toNumberOrNull(ttlText)
    if (parsed === null) {
      return ttlText.trim() === '' ? 'No TTL' : 'Invalid'
    }
    if (parsed === -1) {
      return 'No TTL'
    }
    return formatRedisTTL(parsed) ?? 'No TTL'
  }, [ttlText])

  const handlePreset = (value: number) => {
    setTtlText(String(value))
    setError(null)
  }

  const handlePersist = () => {
    setTtlText('-1')
    setError(null)
  }

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault()
    const parsed = toNumberOrNull(ttlText)
    if (parsed === null) {
      setError('TTL must be a number of seconds.')
      return
    }
    if (parsed < -1) {
      setError('TTL cannot be lower than -1.')
      return
    }
    setError(null)
    await onConfirm(parsed)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <form onSubmit={handleSubmit} className="space-y-5">
          <DialogHeader>
            <div className="flex items-center gap-3">
              <div className="flex h-9 w-9 items-center justify-center rounded-md border border-amber-500/20 bg-amber-500/10 text-amber-500">
                <Clock3 className="h-4 w-4" />
              </div>
              <div className="min-w-0">
                <DialogTitle className="font-mono text-sm">Set TTL</DialogTitle>
                <DialogDescription className="truncate font-mono text-[11px] text-muted-foreground">
                  {keyName}
                </DialogDescription>
              </div>
            </div>
          </DialogHeader>

          <div className="space-y-4">
            <div className="grid gap-2 sm:grid-cols-4">
              {PRESETS.map((preset) => (
                <Button
                  key={preset.label}
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-9 justify-center font-mono text-xs"
                  onClick={() => handlePreset(preset.value)}
                >
                  {preset.label}
                </Button>
              ))}
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-9 justify-center font-mono text-xs"
                onClick={handlePersist}
              >
                <TimerReset className="h-3.5 w-3.5" />
                No TTL
              </Button>
            </div>

            <div className="space-y-2">
              <label className="block text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
                TTL in seconds
              </label>
              <Input
                value={ttlText}
                onChange={(event) => {
                  setTtlText(event.target.value)
                  setError(null)
                }}
                placeholder="3600"
                inputMode="numeric"
                className="font-mono"
              />
            </div>

            <div className="rounded-sm border border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
              Preview: <span className="font-mono text-foreground">{preview}</span>
            </div>

            {error && <p className="text-xs text-destructive">{error}</p>}
          </div>

          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline" size="sm" className="h-8 px-3">
                <X className="h-3.5 w-3.5" />
                Cancel
              </Button>
            </DialogClose>
            <Button type="submit" size="sm" className={cn('h-8 px-3')} disabled={saving}>
              {saving ? 'Saving…' : 'Save TTL'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
