import { useState } from 'react'
import { Copy, Maximize2 } from 'lucide-react'
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

interface KafkaMessageDetailProps {
  message: KafkaMessageRow
  /** Present in the inline row expansion: opens the same message in a modal. */
  onExpand?: () => void
  /** Modal variant: give the value pane most of the viewport height. */
  tall?: boolean
}

export function KafkaMessageDetail({ message, onExpand, tall }: KafkaMessageDetailProps) {
  const [pretty, setPretty] = useState(true)
  const pushToast = useToastStore((state) => state.push)

  const copyToClipboard = async (payload: string, what: string) => {
    try {
      await navigator.clipboard.writeText(payload)
      pushToast({ tone: 'success', title: `${what} copied`, message: `${message.partition}:${message.offset}` })
    } catch {
      pushToast({ tone: 'error', title: 'Copy failed', message: 'Clipboard is unavailable.' })
    }
  }

  const headers = Object.entries(message.headers ?? {})

  return (
    <div className="space-y-3 border-t border-border/60 bg-muted/10 px-4 py-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <div className="mb-1 flex items-center gap-2">
            <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">Key</span>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-6 gap-1 px-2 font-mono text-[10px]"
              disabled={message.key === ''}
              onClick={() => void copyToClipboard(message.key, 'Key')}
            >
              <Copy className="h-3 w-3" />
              Copy
            </Button>
          </div>
          <pre className="max-h-32 overflow-auto whitespace-pre-wrap [overflow-wrap:anywhere] rounded-sm border border-border/70 bg-background/60 px-3 py-2 font-mono text-xs">
            {message.key === '' ? <span className="text-muted-foreground">(empty)</span> : message.key}
          </pre>
        </div>
        <div>
          <div className="mb-1 flex h-6 items-center font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">Metadata</div>
          <div className="rounded-sm border border-border/70 bg-background/60 px-3 py-2 font-mono text-xs text-muted-foreground">
            <div>partition {message.partition} · offset {message.offset}</div>
            <div className="mt-1">{message.timestamp}</div>
          </div>
        </div>
      </div>

      <div>
        <div className="mb-1 flex items-center gap-2">
          <span className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
            Value <KafkaFormatBadge format={message.format} />
          </span>
          {message.format === 'json' && (
            <Button type="button" size="sm" variant="ghost" className="h-6 px-2 font-mono text-[10px]" onClick={() => setPretty((current) => !current)}>
              {pretty ? 'Raw' : 'Formatted'}
            </Button>
          )}
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="h-6 gap-1 px-2 font-mono text-[10px]"
            onClick={() => void copyToClipboard(prettyValue(message.value, message.format, pretty), 'Value')}
          >
            <Copy className="h-3 w-3" />
            Copy
          </Button>
          {onExpand && (
            <Button type="button" size="sm" variant="ghost" className="h-6 gap-1 px-2 font-mono text-[10px]" onClick={onExpand}>
              <Maximize2 className="h-3 w-3" />
              Expand
            </Button>
          )}
        </div>
        <pre
          className={`${tall ? 'max-h-[62vh]' : 'max-h-72'} overflow-auto whitespace-pre-wrap [overflow-wrap:anywhere] rounded-sm border border-border/70 bg-background/60 px-3 py-2 font-mono text-xs`}
        >
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
                    <td className="px-3 py-1.5 font-mono [overflow-wrap:anywhere]">{value}</td>
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
