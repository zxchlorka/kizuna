import { useEffect, useRef } from 'react'
import { TerminalSquare } from 'lucide-react'
import { RedisResultFormatter } from '@/components/redis/RedisCli/RedisResultFormatter'
import type { RedisCliEntry } from '@/stores/redisCli'

interface RedisCliOutputProps {
  entries: RedisCliEntry[]
}

export function RedisCliOutput({ entries }: RedisCliOutputProps) {
  const containerRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!containerRef.current) {
      return
    }
    containerRef.current.scrollTop = containerRef.current.scrollHeight
  }, [entries])

  return (
    <div ref={containerRef} className="relative z-10 flex-1 overflow-auto px-4 py-4">
      {entries.length === 0 ? (
        <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
          <div className="flex h-12 w-12 items-center justify-center rounded-lg border border-border bg-card/60">
            <TerminalSquare className="h-5 w-5 text-accent/70" />
          </div>
          <div className="space-y-1">
            <p className="font-mono text-sm text-foreground">Redis session ready</p>
            <p className="font-mono text-xs text-muted-foreground">
              Type a command below — try <span className="text-accent">PING</span> or{' '}
              <span className="text-accent">INFO server</span>.
            </p>
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          {entries.map((entry) => (
            <div key={entry.id} className="group/entry border-l-2 border-border pl-3 transition-colors hover:border-accent/40">
              <div className="flex items-center justify-between gap-3 font-mono text-[13px]">
                <div className="min-w-0 truncate">
                  <span className="mr-2 select-none font-semibold text-accent">redis&gt;</span>
                  <span className="text-foreground">{entry.statement}</span>
                </div>
                <span className="shrink-0 rounded-full border border-border bg-muted/30 px-2 py-0.5 text-[10px] tabular-nums text-muted-foreground">
                  {entry.result.duration_ms}ms
                </span>
              </div>
              <div className="mt-2">
                <RedisResultFormatter result={entry.result} />
              </div>
              {entry.result.truncated ? (
                <div className="mt-1.5 font-mono text-[11px] text-amber-600 dark:text-amber-400">
                  Output truncated to the first {entry.result.applied_limit ?? 1000} rows.
                </div>
              ) : null}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
