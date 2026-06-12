import { useEffect, useRef } from 'react'
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
    <div ref={containerRef} className="flex-1 overflow-auto px-4 py-4">
      {entries.length === 0 ? (
        <div className="font-mono text-sm text-muted-foreground">Run a command to start this session.</div>
      ) : (
        <div className="space-y-5">
          {entries.map((entry) => (
            <div key={entry.id} className="space-y-2">
              <div className="flex items-center justify-between gap-3 font-mono text-sm text-sky-400">
                <div className="min-w-0 truncate">
                  <span className="mr-2 text-muted-foreground">redis&gt;</span>
                  {entry.statement}
                </div>
                <span className="rounded-sm border border-border/70 bg-background/60 px-2 py-0.5 text-[10px] text-muted-foreground">
                  {entry.result.duration_ms}ms
                </span>
              </div>
              <RedisResultFormatter result={entry.result} />
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
