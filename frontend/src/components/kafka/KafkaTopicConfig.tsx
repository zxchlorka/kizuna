import { useCallback, useEffect, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { LoadingSkeleton } from '@/components/LoadingSkeleton'
import { fetchWithTimeout } from '@/lib/http'
import { describeRetentionSize, describeRetentionTime } from '@/lib/kafkaRetention'
import { cn } from '@/lib/utils'

interface KafkaTopicConfigProps {
  connId: string
  topic: string
}

interface TopicConfigFallback {
  key: string
  value: string
  source: string
}

interface TopicConfigEntry {
  key: string
  value: string
  source: string
  set_on_topic: boolean
  fallbacks?: TopicConfigFallback[]
}

interface TopicSchema {
  meta?: {
    partitions?: number
    replication?: number
    configs?: TopicConfigEntry[]
  }
}

function headlineCard(label: string, value: string, note: string) {
  return (
    <div className="rounded-sm border border-border bg-muted/10 px-3 py-3">
      <div className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground">{label}</div>
      <div className="mt-2 font-mono text-sm">{value}</div>
      <div className="mt-1 font-mono text-[11px] leading-relaxed text-muted-foreground">{note}</div>
    </div>
  )
}

export function KafkaTopicConfig({ connId, topic }: KafkaTopicConfigProps) {
  const [schema, setSchema] = useState<TopicSchema | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetchWithTimeout(
        `/api/connections/${connId}/objects/${encodeURIComponent(topic)}/schema`
      )
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: res.statusText }))
        throw new Error(body.error || 'Failed to load topic config')
      }
      setSchema((await res.json()) as TopicSchema)
    } catch (loadError) {
      setError((loadError as Error).message)
    } finally {
      setLoading(false)
    }
  }, [connId, topic])

  useEffect(() => {
    void load()
  }, [load])

  if (loading && !schema) {
    return <LoadingSkeleton variant="table" />
  }

  if (error) {
    return (
      <div className="rounded-sm border border-destructive/40 bg-destructive/5 px-3 py-3 font-mono text-xs text-destructive">
        {error}
      </div>
    )
  }

  const partitions = schema?.meta?.partitions ?? 0
  const configs = schema?.meta?.configs ?? []
  const byKey = new Map(configs.map((config) => [config.key, config.value]))

  const size = describeRetentionSize(byKey.get('retention.bytes'), partitions)
  const time = describeRetentionTime(byKey.get('retention.ms'))

  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
        {headlineCard('Retention size', size.perPartition ?? 'None', size.note)}
        {headlineCard('Retention time', time, 'Applies to the topic as a whole')}
        {headlineCard(
          'Partitions',
          String(partitions),
          size.topicTotal
            ? `Each holds up to ${size.perPartition}`
            : 'Retention size is enforced on each one separately'
        )}
      </div>

      <div className="rounded-sm border border-border">
        <div className="flex items-center gap-2 border-b border-border px-3 py-2">
          <div className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
            All configs ({configs.length})
          </div>
          {loading && <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />}
        </div>
        <div className="overflow-x-auto">
          <table className="w-full font-mono text-xs">
            <thead>
              <tr className="border-b border-border text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
                <th className="px-3 py-2 text-left font-normal">Key</th>
                <th className="px-3 py-2 text-left font-normal">Value</th>
                <th className="px-3 py-2 text-left font-normal">Set by</th>
                <th className="px-3 py-2 text-left font-normal">Without the override</th>
              </tr>
            </thead>
            <tbody>
              {configs.map((config) => (
                <tr key={config.key} className="border-b border-border/50 last:border-b-0">
                  <td className="px-3 py-1.5 align-top">{config.key}</td>
                  <td className="whitespace-pre-wrap break-all px-3 py-1.5 align-top">{config.value || '—'}</td>
                  <td
                    className={cn(
                      'px-3 py-1.5 align-top',
                      // An explicit topic-level value is the one somebody chose;
                      // everything else is a default that can move under you.
                      config.set_on_topic ? 'text-amber-600 dark:text-amber-400' : 'text-muted-foreground'
                    )}
                  >
                    {config.source}
                  </td>
                  {/* What this setting falls back to. A value set on the topic
                      says nothing about what the cluster would apply without it,
                      or which broker setting to change for every topic at once. */}
                  <td className="px-3 py-1.5 align-top text-muted-foreground">
                    {config.fallbacks && config.fallbacks.length > 0
                      ? config.fallbacks
                          .filter((fallback) => fallback.source !== config.source)
                          .map((fallback) => `${fallback.key} = ${fallback.value || '—'} (${fallback.source})`)
                          .join(' · ') || '—'
                      : '—'}
                  </td>
                </tr>
              ))}
              {configs.length === 0 && (
                <tr>
                  <td colSpan={4} className="px-3 py-6 text-center text-muted-foreground">
                    The broker reported no configs for this topic.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
