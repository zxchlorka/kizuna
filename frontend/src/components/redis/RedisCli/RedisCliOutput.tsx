import { useCallback, useEffect, useRef } from 'react'
import { ArrowUpRight, TerminalSquare } from 'lucide-react'
import { RedisResultFormatter } from '@/components/redis/RedisCli/RedisResultFormatter'
import { parseRedisKeyFromCommand } from '@/lib/redisCommand'
import { useDataStore } from '@/stores/data'
import { useToastStore } from '@/stores/toast'
import { useWorkspaceStore } from '@/stores/workspace'
import type { RedisCliEntry } from '@/stores/redisCli'

interface RedisCliOutputProps {
  connId: string
  entries: RedisCliEntry[]
}

export function RedisCliOutput({ connId, entries }: RedisCliOutputProps) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const resolveObjectType = useDataStore((state) => state.resolveObjectType)
  const openTab = useWorkspaceStore((state) => state.openTab)
  const pushToast = useToastStore((state) => state.push)

  const openKey = useCallback(
    (value: string) => {
      const key = value.trim()
      if (!key) return
      void resolveObjectType(connId, key)
        .then((type) => openTab(connId, key, type))
        .catch(() => pushToast({ tone: 'error', title: 'Key not found', message: key }))
    },
    [connId, resolveObjectType, openTab, pushToast]
  )

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
          {entries.map((entry) => {
            const cmdKey = parseRedisKeyFromCommand(entry.statement)
            return (
              <div key={entry.id} className="group/entry border-l-2 border-border pl-3 transition-colors hover:border-accent/40">
                <div className="flex items-center justify-between gap-3 font-mono text-[13px]">
                  <div className="min-w-0 truncate">
                    <span className="mr-2 select-none font-semibold text-accent">redis&gt;</span>
                    <span className="text-foreground">{entry.statement}</span>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    {cmdKey ? (
                      <button
                        type="button"
                        onClick={() => openKey(cmdKey)}
                        className="inline-flex items-center gap-1 rounded-sm border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground hover:border-accent/40 hover:text-foreground"
                        title={`Open key ${cmdKey}`}
                      >
                        <ArrowUpRight className="h-3 w-3" />
                        open {cmdKey}
                      </button>
                    ) : null}
                    <span className="rounded-full border border-border bg-muted/30 px-2 py-0.5 text-[10px] tabular-nums text-muted-foreground">
                      {entry.result.duration_ms}ms
                    </span>
                  </div>
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
            )
          })}
        </div>
      )}
    </div>
  )
}
