import { Info } from 'lucide-react'

interface KafkaCoverageBannerProps {
  messageCount: number
  partitionsCompleted: number
  partitionsTotal: number
  reason?: string | null
}

// Non-error, informational banner for a partial browse response (the reader
// hit its read budget before every scoped partition finished). Renders
// alongside the message table — it never replaces it. Real errors (auth,
// unavailable broker, unknown topic, ...) still go through ErrorBanner.
//
// `messageCount` is the cumulative row count currently on screen (i.e. the
// table's row count, `messages.length` at the call site), not a single
// response's raw `messages_returned` wire field — after a "Load older" merge
// the table can hold more rows than any one response returned, and this
// banner sits directly above that table, so its count must describe what's
// actually rendered rather than the latest fetch in isolation.
// `partitionsCompleted`/`partitionsTotal` intentionally stay tied to the
// latest response — there's no meaningful cumulative partition count across
// multiple page loads.
export function KafkaCoverageBanner({ messageCount, partitionsCompleted, partitionsTotal, reason }: KafkaCoverageBannerProps) {
  return (
    <div
      className="flex items-center gap-2 rounded-sm border border-amber-500/30 bg-amber-500/5 px-3 py-2 font-mono text-[11px] text-amber-600 dark:text-amber-400"
      title={reason ? `Partial reason: ${reason}` : undefined}
    >
      <Info className="h-3.5 w-3.5 shrink-0" />
      <span>
        Showing {messageCount.toLocaleString()} messages · {partitionsCompleted.toLocaleString()} of{' '}
        {partitionsTotal.toLocaleString()} partitions responded
      </span>
    </div>
  )
}
