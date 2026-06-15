import { useState } from 'react'
import { Copy } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { KafkaFormatBadge } from '@/components/kafka/KafkaFormatBadge'
import { useToastStore } from '@/stores/toast'
import type { KafkaMessageRow } from '@/stores/kafka'

function prettyValue(value: string, format: string, pretty: boolean): string {
  if (!pretty || format !== 'json') {
    return value
  }
  try {
    return JSON.stringify(JSON.parse(value), null, 2)
  } catch {
    return value
  }
}

export function KafkaMessageDetail({ message }: { message: KafkaMessageRow }) {
  const [pretty, setPretty] = useState(true)
  const pushToast = useToastStore((state) => state.push)

  const copyValue = async () => {
    try {
      await navigator.clipboard.writeText(message.value)
      pushToast({ tone: 'success', title: 'Value copied', message: `${message.partition}:${message.offset}` })
    } catch {
      pushToast({ tone: 'error', title: 'Copy failed', message: 'Clipboard is unavailable.' })
    }
  }

  const headers = Object.entries(message.headers ?? {})

  return (
    <div className="space-y-3 border-t border-border/60 bg-muted/10 px-4 py-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <div className="mb-1 flex items-center justify-between">
            <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">Key</span>
          </div>
          <pre className="max-h-32 overflow-auto whitespace-pre-wrap break-words rounded-sm border border-border/70 bg-background/60 px-3 py-2 font-mono text-xs">
            {message.key === '' ? <span className="text-muted-foreground">(empty)</span> : message.key}
          </pre>
        </div>
        <div>
          <div className="mb-1 font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">Metadata</div>
          <div className="rounded-sm border border-border/70 bg-background/60 px-3 py-2 font-mono text-xs text-muted-foreground">
            <div>partition {message.partition} · offset {message.offset}</div>
            <div className="mt-1">{message.timestamp}</div>
          </div>
        </div>
      </div>

      <div>
        <div className="mb-1 flex items-center justify-between gap-2">
          <span className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
            Value <KafkaFormatBadge format={message.format} />
          </span>
          <div className="flex items-center gap-1">
            {message.format === 'json' && (
              <Button type="button" size="sm" variant="ghost" className="h-6 px-2 font-mono text-[10px]" onClick={() => setPretty((current) => !current)}>
                {pretty ? 'Raw' : 'Formatted'}
              </Button>
            )}
            <Button type="button" size="sm" variant="ghost" className="h-6 gap-1 px-2 font-mono text-[10px]" onClick={() => void copyValue()}>
              <Copy className="h-3 w-3" />
              Copy
            </Button>
          </div>
        </div>
        <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-sm border border-border/70 bg-background/60 px-3 py-2 font-mono text-xs">
          {message.value === '' ? <span className="text-muted-foreground">(empty)</span> : prettyValue(message.value, message.format, pretty)}
        </pre>
      </div>

      {headers.length > 0 && (
        <div>
          <div className="mb-1 font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">Headers</div>
          <div className="overflow-x-auto rounded-sm border border-border/70">
            <table className="min-w-[260px] divide-y divide-border text-xs">
              <tbody className="divide-y divide-border/60">
                {headers.map(([key, value]) => (
                  <tr key={key}>
                    <td className="px-3 py-1.5 font-mono text-cyan-700 dark:text-cyan-300">{key}</td>
                    <td className="px-3 py-1.5 font-mono">{value}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}
