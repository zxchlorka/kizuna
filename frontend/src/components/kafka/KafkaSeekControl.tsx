import { useEffect, useState, type FormEvent } from 'react'
import { CornerRightDown, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import type { KafkaSeek } from '@/stores/kafka'

interface KafkaSeekControlProps {
  seek: KafkaSeek
  // An offset seek needs a single partition; null means "All partitions", where
  // only the timestamp form is offered.
  partitionFilter: number | null
  disabled: boolean
  onApply: (seek: KafkaSeek) => void
}

type SeekMode = 'timestamp' | 'offset'

// <input type="datetime-local"> speaks local wall-clock with no zone, e.g.
// "2026-07-27T08:41". The API wants RFC3339, so the two conversions below are
// the only place the browser's zone is applied — everything else stays RFC3339.
function localInputToRfc3339(local: string): string {
  if (!local) return ''
  const parsed = new Date(local)
  return Number.isNaN(parsed.getTime()) ? '' : parsed.toISOString()
}

function rfc3339ToLocalInput(rfc: string): string {
  if (!rfc) return ''
  const parsed = new Date(rfc)
  if (Number.isNaN(parsed.getTime())) return ''
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${parsed.getFullYear()}-${pad(parsed.getMonth() + 1)}-${pad(parsed.getDate())}T${pad(
    parsed.getHours()
  )}:${pad(parsed.getMinutes())}`
}

// Where a browse starts reading. Both forms are inclusive and read backwards
// from the chosen point, which is the only direction the reader goes, so the
// control is labelled "From" rather than offering a direction the reader cannot
// honour. It sits beside the partition selector because the offset form is only
// available once a single partition is chosen.
export function KafkaSeekControl({ seek, partitionFilter, disabled, onApply }: KafkaSeekControlProps) {
  const offsetAvailable = partitionFilter !== null

  const [mode, setMode] = useState<SeekMode>(() => (seek.offset ? 'offset' : 'timestamp'))
  const [offsetInput, setOffsetInput] = useState(seek.offset)
  const [timestampInput, setTimestampInput] = useState(() => rfc3339ToLocalInput(seek.timestamp))

  // Re-sync when the tab's anchor changes from elsewhere — switching to all
  // partitions drops an offset seek, and the inputs must follow.
  useEffect(() => {
    setOffsetInput(seek.offset)
    setTimestampInput(rfc3339ToLocalInput(seek.timestamp))
  }, [seek.offset, seek.timestamp])

  useEffect(() => {
    if (!offsetAvailable) setMode('timestamp')
  }, [offsetAvailable])

  const active = seek.offset !== '' || seek.timestamp !== ''

  const apply = (event: FormEvent) => {
    event.preventDefault()
    if (disabled) return
    onApply(
      mode === 'offset'
        ? { offset: offsetInput.trim(), timestamp: '' }
        : { offset: '', timestamp: localInputToRfc3339(timestampInput) }
    )
  }

  const clear = () => {
    setOffsetInput('')
    setTimestampInput('')
    onApply({ offset: '', timestamp: '' })
  }

  return (
    <form onSubmit={apply} className="flex flex-wrap items-center gap-2">
      <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-muted-foreground">From</span>

      {/* Mode toggle. Two options only, so a segmented pair reads faster than a
          select and keeps the chosen mode visible without opening anything. */}
      <div className="flex items-center rounded-sm border border-border p-0.5">
        {(['timestamp', 'offset'] as const).map((option) => {
          const unavailable = option === 'offset' && !offsetAvailable
          return (
            <button
              key={option}
              type="button"
              disabled={unavailable}
              onClick={() => setMode(option)}
              title={unavailable ? 'Select a single partition to seek by offset' : undefined}
              className={cn(
                'rounded-[2px] px-2 py-0.5 font-mono text-[11px] transition-colors',
                mode === option ? 'bg-orange-500/15 text-orange-500' : 'text-muted-foreground hover:text-foreground',
                unavailable && 'cursor-not-allowed opacity-40 hover:text-muted-foreground'
              )}
            >
              {option === 'timestamp' ? 'Time' : 'Offset'}
            </button>
          )
        })}
      </div>

      {mode === 'offset' ? (
        <input
          value={offsetInput}
          onChange={(event) => setOffsetInput(event.target.value.replace(/[^\d]/g, ''))}
          placeholder="Offset"
          aria-label="Start from offset"
          inputMode="numeric"
          spellCheck={false}
          autoComplete="off"
          className="h-8 w-44 rounded-sm border border-border bg-background px-2 font-mono text-xs tabular-nums outline-none placeholder:text-muted-foreground focus:border-orange-500/50"
        />
      ) : (
        <input
          type="datetime-local"
          value={timestampInput}
          onChange={(event) => setTimestampInput(event.target.value)}
          aria-label="Start from time"
          className="h-8 rounded-sm border border-border bg-background px-2 font-mono text-xs outline-none focus:border-orange-500/50"
        />
      )}

      <Button
        type="submit"
        size="sm"
        variant="outline"
        className="h-8 gap-1.5 font-mono text-[11px]"
        disabled={disabled || (mode === 'offset' ? offsetInput.trim() === '' : timestampInput === '')}
      >
        <CornerRightDown className="h-3.5 w-3.5" />
        Seek
      </Button>

      {active && (
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="h-8 gap-1 px-1.5 font-mono text-[11px]"
          onClick={clear}
          disabled={disabled}
        >
          <X className="h-3 w-3" />
          Back to newest
        </Button>
      )}
    </form>
  )
}
