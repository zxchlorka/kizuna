import { useEffect, useState, type FormEvent } from 'react'
import { CornerRightDown, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import type { KafkaSeek } from '@/stores/kafka'

interface KafkaSeekControlProps {
  seek: KafkaSeek
  partitionFilter: number | null
  // Coverage of the last response: how many scoped partitions had anything to
  // read, out of how many are scoped. Only meaningful to show for an offset seek
  // over several partitions — see the readout below.
  partitionsWindowed: number
  partitionsTotal: number
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

// Where a browse starts reading. Both forms are inclusive and continue in the
// tab's direction, so the control is labelled "From" and the Newest/Oldest
// toggle beside it decides which way.
//
// An offset applies to every scoped partition. Offsets are per-partition
// identifiers, so one number lands inside only the partitions whose range
// contains it — on a topic whose partitions have drifted far apart that can be a
// handful out of dozens. That is a real answer, not an error, so the control
// allows it and reports the coverage instead of refusing the input.
export function KafkaSeekControl({
  seek,
  partitionFilter,
  partitionsWindowed,
  partitionsTotal,
  disabled,
  onApply,
}: KafkaSeekControlProps) {
  const [mode, setMode] = useState<SeekMode>(() => (seek.offset ? 'offset' : 'timestamp'))
  const [offsetInput, setOffsetInput] = useState(seek.offset)
  const [timestampInput, setTimestampInput] = useState(() => rfc3339ToLocalInput(seek.timestamp))

  // Re-sync when the tab's anchor changes from elsewhere (a cleared seek, a
  // restored tab) so the inputs never show a point the reader is not using.
  useEffect(() => {
    setOffsetInput(seek.offset)
    setTimestampInput(rfc3339ToLocalInput(seek.timestamp))
  }, [seek.offset, seek.timestamp])

  const active = seek.offset !== '' || seek.timestamp !== ''
  // Only an offset spread over several partitions can partially miss; a single
  // partition or a timestamp seek always resolves everywhere it applies.
  const showCoverage = seek.offset !== '' && partitionFilter === null && partitionsTotal > 1

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
        {(['timestamp', 'offset'] as const).map((option) => (
          <button
            key={option}
            type="button"
            onClick={() => setMode(option)}
            className={cn(
              'rounded-[2px] px-2 py-0.5 font-mono text-[11px] transition-colors',
              mode === option ? 'bg-orange-500/15 text-orange-500' : 'text-muted-foreground hover:text-foreground'
            )}
          >
            {option === 'timestamp' ? 'Time' : 'Offset'}
          </button>
        ))}
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

      {/* Coverage of an offset seek spread over several partitions. A partition
          whose range does not contain the number contributes nothing, so this is
          the difference between "the topic is quiet" and "that offset does not
          exist here". Amber once some partitions dropped out. */}
      {showCoverage && (
        <span
          className={cn(
            'font-mono text-[11px] tabular-nums',
            partitionsWindowed < partitionsTotal ? 'text-amber-600 dark:text-amber-400' : 'text-muted-foreground'
          )}
          title="Partitions whose offset range contains this offset. The rest have nothing at that position."
        >
          {partitionsWindowed} of {partitionsTotal} partitions in range
        </span>
      )}

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
          Clear
        </Button>
      )}
    </form>
  )
}
