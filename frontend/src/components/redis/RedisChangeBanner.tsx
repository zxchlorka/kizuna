import { ArrowRight, Minus, Plus, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { isEmptyDelta, type RedisDelta } from '@/lib/redisDelta'

// Enough entries to see what happened, few enough that the line stays a line.
// A refresh that moved thirty fields is not read entry by entry anyway — the
// counts above tell that story.
const SHOWN = 6

/**
 * What moved since the last read of this key.
 *
 * Not a diff screen and not something to open: it is the answer to "did my
 * change land", put where you already are when you ask. Nobody reads a diff by
 * choice, but everybody reads one line that says `+ gaid_ids · manual-c6-gaid`.
 */
export function RedisChangeBanner({ delta, onDismiss }: { delta: RedisDelta; onDismiss: () => void }) {
  if (isEmptyDelta(delta)) {
    return null
  }

  const counts = [
    delta.added.length > 0 ? `+${delta.added.length}` : null,
    delta.changed.length > 0 ? `~${delta.changed.length}` : null,
    delta.removed.length > 0 ? `−${delta.removed.length}` : null,
  ].filter(Boolean)

  const total = delta.added.length + delta.changed.length + delta.removed.length
  const shown =
    Math.min(SHOWN, delta.added.length) + Math.min(SHOWN, delta.changed.length) + Math.min(SHOWN, delta.removed.length)
  const overflow = total - shown

  return (
    <div className="rounded-sm border border-amber-500/35 bg-amber-500/[0.08] px-3 py-2">
      <div className="flex items-start justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2 font-mono text-[11px]">
          <span className="text-[10px] uppercase tracking-[0.14em] text-amber-600 dark:text-amber-500">
            Since the last refresh
          </span>
          <span className="text-muted-foreground">{counts.join(' · ')}</span>
        </div>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="h-5 w-5 shrink-0 p-0"
          onClick={onDismiss}
          title="Dismiss"
          aria-label="Dismiss the change summary"
        >
          <X className="h-3 w-3" />
        </Button>
      </div>

      <div className="mt-1.5 flex flex-col gap-0.5 font-mono text-[11px]">
        {delta.added.slice(0, SHOWN).map((entry) => (
          <div key={`a-${entry.id}`} className="flex items-center gap-1.5 text-emerald-600 dark:text-emerald-400">
            <Plus className="h-3 w-3 shrink-0" />
            {/* Not truthiness: "0" is a perfectly good flag value, and on it the
                  field would have rendered with no value at all. */}
              <span className="truncate">
                {entry.value === undefined || entry.value === '' ? entry.id : `${entry.id} · ${entry.value}`}
              </span>
          </div>
        ))}
        {delta.changed.slice(0, SHOWN).map((entry) => (
          <div key={`c-${entry.id}`} className="flex items-center gap-1.5">
            <ArrowRight className="h-3 w-3 shrink-0 text-amber-600 dark:text-amber-500" />
            <span className="truncate">
              <span className="text-foreground">{entry.id}</span>{' '}
              <span className="text-muted-foreground line-through">{entry.previous}</span>{' '}
              <span className="text-emerald-600 dark:text-emerald-400">{entry.value}</span>
            </span>
          </div>
        ))}
        {delta.removed.slice(0, SHOWN).map((entry) => (
          <div key={`r-${entry.id}`} className="flex items-center gap-1.5 text-red-600 dark:text-red-400">
            <Minus className="h-3 w-3 shrink-0" />
            <span className="truncate">{entry.id}</span>
          </div>
        ))}
        {overflow > 0 && <div className="text-muted-foreground">…and {overflow} more</div>}
      </div>
    </div>
  )
}
