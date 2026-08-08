import { useCallback, useEffect, useState } from 'react'
import { AlertTriangle, Database, Loader2, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { fetchWithTimeout } from '@/lib/http'
import { formatBytes, formatDurationSeconds, formatExactCount } from '@/lib/numberFormat'
import { cn } from '@/lib/utils'
import { useConnectionStore } from '@/stores/connections'
import type { ConnectionInfo } from '@/types/api'

interface RedisOverviewProps {
  connId: string
}

// INFO reports every field as a string; a missing field and an unparseable one
// are the same thing here — a number we do not have and must not invent.
function num(extra: Record<string, unknown> | undefined, key: string): number | null {
  const raw = extra?.[key]
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null
  if (typeof raw !== 'string' || raw === '') return null
  const parsed = Number(raw)
  return Number.isFinite(parsed) ? parsed : null
}

function str(extra: Record<string, unknown> | undefined, key: string): string | null {
  const raw = extra?.[key]
  return typeof raw === 'string' && raw !== '' ? raw : null
}

function statCard(label: string, value: string, hint?: string) {
  return (
    <div className="rounded-sm border border-border bg-muted/10 px-3 py-3">
      <div className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground">{label}</div>
      <div className="mt-2 font-mono text-sm">{value}</div>
      {hint && <div className="mt-1 font-mono text-[11px] text-muted-foreground">{hint}</div>}
    </div>
  )
}

// The meter is drawn only against a real ceiling. maxmemory 0 means Redis is not
// enforcing one at all, and a bar sitting at 0% would read as "plenty of room"
// for a server that will in fact keep growing until the host runs out.
function MemoryMeter({ used, max }: { used: number; max: number }) {
  const ratio = Math.min(used / max, 1)
  const percent = ratio * 100
  const level = percent >= 90 ? 'critical' : percent >= 75 ? 'warning' : 'normal'

  return (
    <div>
      <div className="flex items-baseline justify-between gap-3">
        <div className="font-mono text-sm">
          {formatBytes(used)} <span className="text-muted-foreground">of {formatBytes(max)}</span>
        </div>
        <div className="flex items-center gap-2 font-mono text-sm">
          {level !== 'normal' && (
            <span
              className={cn(
                'inline-flex items-center gap-1 rounded-sm border px-1.5 py-0.5 text-[10px] uppercase tracking-[0.12em]',
                level === 'critical'
                  ? 'border-red-500/30 bg-red-500/5 text-red-600 dark:text-red-400'
                  : 'border-orange-500/30 bg-orange-500/5 text-orange-600 dark:text-orange-400'
              )}
            >
              <AlertTriangle className="h-3 w-3" />
              {level === 'critical' ? 'Near limit' : 'Filling up'}
            </span>
          )}
          {percent.toFixed(1)}%
        </div>
      </div>
      <div
        className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-muted"
        role="meter"
        aria-valuenow={Math.round(percent)}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label="Memory used against the configured limit"
      >
        <div
          className={cn(
            'h-full rounded-full transition-[width]',
            level === 'critical' ? 'bg-red-500' : level === 'warning' ? 'bg-orange-500' : 'bg-amber-500'
          )}
          style={{ width: `${Math.max(ratio * 100, ratio > 0 ? 1 : 0)}%` }}
        />
      </div>
    </div>
  )
}

export function RedisOverview({ connId }: RedisOverviewProps) {
  const connection = useConnectionStore((state) => state.connections.find((item) => item.id === connId))
  const [info, setInfo] = useState<ConnectionInfo | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetchWithTimeout(`/api/connections/${connId}/info`)
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: res.statusText }))
        throw new Error(body.error || 'Failed to load connection info')
      }
      setInfo((await res.json()) as ConnectionInfo)
    } catch (loadError) {
      setError((loadError as Error).message)
    } finally {
      setLoading(false)
    }
  }, [connId])

  useEffect(() => {
    void load()
  }, [load])

  const extra = info?.extra
  const used = num(extra, 'used_memory')
  const max = num(extra, 'maxmemory')
  const peak = num(extra, 'used_memory_peak')
  const rss = num(extra, 'used_memory_rss')
  const policy = str(extra, 'maxmemory_policy')
  const totalKeys = num(extra, 'total_keys')
  const uptime = num(extra, 'uptime_in_seconds')
  const clients = num(extra, 'connected_clients')
  const fragmentation = num(extra, 'mem_fragmentation_ratio')
  const role = str(extra, 'role')
  const mode = str(extra, 'mode')

  return (
    <div className="flex-1 overflow-auto p-4">
      <div className="mx-auto flex max-w-4xl flex-col gap-3">
        <div className="rounded-sm border border-border bg-card p-4">
          <div className="flex items-start justify-between gap-4">
            <div className="flex items-start gap-3">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-sm border border-red-500/30 bg-red-500/5">
                <Database className="h-5 w-5 text-red-500" />
              </div>
              <div className="min-w-0">
                <div className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground">Redis overview</div>
                <div className="mt-1 truncate font-mono text-lg">{connection?.name ?? connId}</div>
                <div className="mt-2 flex flex-wrap items-center gap-1.5">
                  {[mode, info?.version && `v${info.version}`, role].filter(Boolean).map((badge) => (
                    <span
                      key={badge as string}
                      className="inline-flex items-center rounded-sm border border-border px-2 py-1 font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground"
                    >
                      {badge}
                    </span>
                  ))}
                </div>
              </div>
            </div>
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-7 shrink-0 gap-1.5 font-mono text-[11px]"
              disabled={loading}
              onClick={() => void load()}
            >
              <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />
              Refresh
            </Button>
          </div>
        </div>

        {error && (
          <div className="rounded-sm border border-destructive/40 bg-destructive/5 px-3 py-3 font-mono text-xs text-destructive">
            {error}
          </div>
        )}

        {loading && !info && (
          <div className="flex items-center gap-2 rounded-sm border border-border bg-muted/10 px-3 py-6 font-mono text-xs text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            Reading server info…
          </div>
        )}

        {info && (
          <>
            <div className="rounded-sm border border-border bg-card p-4">
              <div className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground">Memory</div>
              <div className="mt-3">
                {used === null ? (
                  <div className="font-mono text-xs text-muted-foreground">
                    This server did not report its memory use.
                  </div>
                ) : max !== null && max > 0 ? (
                  <MemoryMeter used={used} max={max} />
                ) : (
                  <div>
                    <div className="font-mono text-sm">{formatBytes(used)} used</div>
                    <div className="mt-1 font-mono text-[11px] text-muted-foreground">
                      No maxmemory limit is set — this server grows until the host runs out, and evicts nothing on
                      its own.
                    </div>
                  </div>
                )}
              </div>
              <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-3">
                {statCard('Policy', policy ?? '—', policy === 'noeviction' ? 'Writes fail at the limit' : undefined)}
                {statCard('Peak', peak === null ? '—' : formatBytes(peak))}
                {statCard('RSS', rss === null ? '—' : formatBytes(rss))}
              </div>
            </div>

            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              {statCard(
                'Total keys',
                totalKeys === null ? '—' : formatExactCount(totalKeys),
                totalKeys === null ? 'Not counted' : mode === 'cluster' ? 'Summed across masters' : undefined
              )}
              {statCard('Uptime', uptime === null ? '—' : formatDurationSeconds(uptime))}
              {statCard('Clients', clients === null ? '—' : formatExactCount(clients))}
              {statCard(
                'Fragmentation',
                fragmentation === null ? '—' : fragmentation.toFixed(2),
                fragmentation !== null && fragmentation > 1.5 ? 'More RSS than data' : undefined
              )}
            </div>
          </>
        )}
      </div>
    </div>
  )
}
