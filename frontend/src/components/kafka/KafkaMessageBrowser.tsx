import { Fragment, useState, type FormEvent } from 'react'
import { ChevronDown, ChevronRight, ChevronsDown, Loader2, RefreshCw, Search, X } from 'lucide-react'
import { KafkaFormatBadge } from '@/components/kafka/KafkaFormatBadge'
import { KafkaMessageDetail } from '@/components/kafka/KafkaMessageDetail'
import { EmptyState } from '@/components/EmptyState'
import { ErrorBanner } from '@/components/ErrorBanner'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { cn } from '@/lib/utils'
import type { KafkaMessageRow } from '@/stores/kafka'

interface KafkaMessageBrowserProps {
  messages: KafkaMessageRow[]
  loading: boolean
  loadingOlder: boolean
  error: string | null
  hasOlder: boolean
  partitionCount: number
  partitionFilter: number | null
  searchActive: boolean
  scanned: number
  onPartitionChange: (partition: number | null) => void
  onRefresh: () => void
  onLoadOlder: () => void
  onSearch: (field: string, value: string) => void
  onClearSearch: () => void
}

const allPartitions = '__all__'

function valuePreview(value: string): string {
  const collapsed = value.replace(/\s+/g, ' ').trim()
  return collapsed.length > 120 ? `${collapsed.slice(0, 120)}…` : collapsed
}

export function KafkaMessageBrowser({
  messages,
  loading,
  loadingOlder,
  error,
  hasOlder,
  partitionCount,
  partitionFilter,
  searchActive,
  scanned,
  onPartitionChange,
  onRefresh,
  onLoadOlder,
  onSearch,
  onClearSearch,
}: KafkaMessageBrowserProps) {
  const [expanded, setExpanded] = useState<string | null>(null)
  const [fieldInput, setFieldInput] = useState('')
  const [valueInput, setValueInput] = useState('')

  const submitSearch = (event: FormEvent) => {
    event.preventDefault()
    if (!fieldInput.trim() || loading) {
      return
    }
    onSearch(fieldInput, valueInput)
  }

  const handleClear = () => {
    setFieldInput('')
    setValueInput('')
    onClearSearch()
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-muted-foreground">Partition</span>
          <Select
            value={partitionFilter === null ? allPartitions : String(partitionFilter)}
            onValueChange={(value) => onPartitionChange(value === allPartitions ? null : Number.parseInt(value, 10))}
          >
            <SelectTrigger className="h-8 w-36 font-mono text-xs">
              <SelectValue placeholder="All partitions" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={allPartitions}>All partitions</SelectItem>
              {Array.from({ length: partitionCount }, (_, index) => (
                <SelectItem key={index} value={String(index)} className="font-mono text-xs">
                  Partition {index}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <Button type="button" size="sm" variant="outline" className="h-8 gap-1.5 font-mono text-[11px]" onClick={onRefresh} disabled={loading}>
          <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />
          Refresh
        </Button>
      </div>

      <form onSubmit={submitSearch} className="flex flex-wrap items-center gap-2">
        <input
          value={fieldInput}
          onChange={(event) => setFieldInput(event.target.value)}
          placeholder="JSON field (e.g. product_id, user.id)"
          spellCheck={false}
          autoComplete="off"
          className="h-8 w-56 rounded-sm border border-border bg-background px-2 font-mono text-xs outline-none placeholder:text-muted-foreground focus:border-orange-500/50"
        />
        <input
          value={valueInput}
          onChange={(event) => setValueInput(event.target.value)}
          placeholder="equals value"
          spellCheck={false}
          autoComplete="off"
          className="h-8 w-44 rounded-sm border border-border bg-background px-2 font-mono text-xs outline-none placeholder:text-muted-foreground focus:border-orange-500/50"
        />
        <Button type="submit" size="sm" variant="outline" className="h-8 gap-1.5 font-mono text-[11px]" disabled={loading || !fieldInput.trim()}>
          <Search className="h-3.5 w-3.5" />
          Search
        </Button>
        {searchActive && (
          <Button type="button" size="sm" variant="ghost" className="h-8 gap-1.5 font-mono text-[11px]" onClick={handleClear}>
            <X className="h-3.5 w-3.5" />
            Clear
          </Button>
        )}
      </form>

      {searchActive && (
        <div className="font-mono text-[11px] text-muted-foreground">
          Scanned {scanned.toLocaleString()} · found {messages.length.toLocaleString()}
          {!hasOlder && ' · reached beginning'}
        </div>
      )}

      {error && <ErrorBanner message={error} onRetry={onRefresh} />}

      {!error && messages.length === 0 && !loading ? (
        <EmptyState
          variant="no_tables"
          compact
          title={searchActive ? 'No matches' : 'No messages'}
          description={
            searchActive
              ? 'No messages matched in the scanned window. Try “Scan more” to look deeper.'
              : 'The selected partitions returned no messages in the newest window.'
          }
        />
      ) : (
        <div className="overflow-x-auto rounded-sm border border-border/70">
          <table className="min-w-full divide-y divide-border text-sm">
            <thead className="bg-muted/30 text-left text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
              <tr>
                <th className="w-8 px-2 py-2" />
                <th className="px-3 py-2">Part</th>
                <th className="px-3 py-2">Offset</th>
                <th className="px-3 py-2">Timestamp</th>
                <th className="px-3 py-2">Key</th>
                <th className="px-3 py-2">Value</th>
                <th className="px-3 py-2">Format</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/60">
              {messages.map((message) => {
                const rowKey = `${message.partition}:${message.offset}`
                const isExpanded = expanded === rowKey
                return (
                  <Fragment key={rowKey}>
                    <tr
                      className="cursor-pointer transition-colors hover:bg-muted/30"
                      onClick={() => setExpanded(isExpanded ? null : rowKey)}
                    >
                      <td className="px-2 py-2 text-muted-foreground">
                        {isExpanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                      </td>
                      <td className="px-3 py-2 font-mono text-xs">{message.partition}</td>
                      <td className="px-3 py-2 font-mono text-xs">{message.offset}</td>
                      <td className="whitespace-nowrap px-3 py-2 font-mono text-xs text-muted-foreground">{message.timestamp}</td>
                      <td className="max-w-40 truncate px-3 py-2 font-mono text-xs text-cyan-700 dark:text-cyan-300">
                        {message.key || <span className="text-muted-foreground">—</span>}
                      </td>
                      <td className="max-w-md truncate px-3 py-2 font-mono text-xs">{valuePreview(message.value)}</td>
                      <td className="px-3 py-2">
                        <KafkaFormatBadge format={message.format} />
                      </td>
                    </tr>
                    {isExpanded && (
                      <tr>
                        <td colSpan={7} className="p-0">
                          <KafkaMessageDetail message={message} />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {hasOlder && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-8 w-full gap-1.5 font-mono text-[11px]"
          disabled={loadingOlder}
          onClick={onLoadOlder}
        >
          {loadingOlder ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ChevronsDown className="h-3.5 w-3.5" />}
          {searchActive
            ? loadingOlder
              ? 'Scanning…'
              : 'Scan more'
            : loadingOlder
              ? 'Loading older messages…'
              : 'Load older messages'}
        </Button>
      )}
    </div>
  )
}
