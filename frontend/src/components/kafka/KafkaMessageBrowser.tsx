import { Fragment, useEffect, useState, type FormEvent, type MouseEvent } from 'react'
import { ChevronDown, ChevronRight, ChevronsDown, Loader2, RefreshCw, Search, X } from 'lucide-react'
import { KafkaFormatBadge } from '@/components/kafka/KafkaFormatBadge'
import { KafkaMessageDetail } from '@/components/kafka/KafkaMessageDetail'
import { KafkaMessageModal } from '@/components/kafka/KafkaMessageModal'
import { EmptyState } from '@/components/EmptyState'
import { ErrorBanner } from '@/components/ErrorBanner'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { FloatingMenu, FloatingMenuItem, FloatingMenuLabel, FloatingMenuSeparator } from '@/components/ui/floating-menu'
import { extractMessageField, linkSourceLabel, linkTargetLabel } from '@/lib/links'
import { cn } from '@/lib/utils'
import type { KafkaMessageRow } from '@/stores/kafka'
import type { LinkRecord } from '@/types/api'

interface KafkaMessageBrowserProps {
  messages: KafkaMessageRow[]
  loading: boolean
  loadingOlder: boolean
  error: string | null
  hasOlder: boolean
  partitionCount: number
  partitionFilter: number | null
  searchActive: boolean
  searchField: string
  searchValue: string
  scanned: number
  onPartitionChange: (partition: number | null) => void
  onRefresh: () => void
  onLoadOlder: () => void
  onSearch: (field: string, value: string) => void
  onClearSearch: () => void
  deepScanning: boolean
  onDeepScan: (field: string, value: string) => void
  onCancelDeepScan: () => void
  links: LinkRecord[]
  onOpenLink: (link: LinkRecord, value: string) => void
  onCreateLink: (message: KafkaMessageRow) => void
  reverseLinks: LinkRecord[]
  onOpenReverse: (link: LinkRecord, value: string) => void
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
  searchField,
  searchValue,
  scanned,
  onPartitionChange,
  onRefresh,
  onLoadOlder,
  onSearch,
  onClearSearch,
  deepScanning,
  onDeepScan,
  onCancelDeepScan,
  links,
  onOpenLink,
  onCreateLink,
  reverseLinks,
  onOpenReverse,
}: KafkaMessageBrowserProps) {
  const [expanded, setExpanded] = useState<string | null>(null)
  const [modalMessage, setModalMessage] = useState<KafkaMessageRow | null>(null)
  const [fieldInput, setFieldInput] = useState('')
  const [valueInput, setValueInput] = useState('')
  const [menu, setMenu] = useState<{ x: number; y: number; message: KafkaMessageRow } | null>(null)
  const [confirmOpen, setConfirmOpen] = useState(false)

  // Seed the editable inputs from the active search (e.g. a link jump sets it
  // programmatically) so the user sees what's being searched and can refine it.
  useEffect(() => {
    setFieldInput(searchField)
    setValueInput(searchValue)
  }, [searchField, searchValue])

  const openMenu = (event: MouseEvent, message: KafkaMessageRow) => {
    event.preventDefault()
    setMenu({ x: event.clientX, y: event.clientY, message })
  }

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
    <div className="relative space-y-3">
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
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="h-8 gap-1.5 font-mono text-[11px]"
          disabled={loading || deepScanning || !fieldInput.trim()}
          onClick={() => setConfirmOpen(true)}
        >
          <ChevronsDown className="h-3.5 w-3.5" />
          Search all
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
        <div className="rounded-sm border border-border/70">
          {/* Fixed layout: CSS ignores max-width on auto-layout table cells, so a
              single-line JSON value would otherwise stretch the table (and the
              expanded detail row with it) far past the viewport. */}
          <table className="w-full table-fixed divide-y divide-border text-sm">
            <thead className="bg-muted/30 text-left text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
              <tr>
                <th className="w-8 px-2 py-2" />
                <th className="w-14 px-3 py-2">Part</th>
                <th className="w-32 px-3 py-2">Offset</th>
                <th className="w-52 px-3 py-2">Timestamp</th>
                <th className="w-48 px-3 py-2">Key</th>
                <th className="px-3 py-2">Value</th>
                <th className="w-20 px-3 py-2">Format</th>
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
                      onContextMenu={(event) => openMenu(event, message)}
                    >
                      <td className="px-2 py-2 text-muted-foreground">
                        {isExpanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                      </td>
                      <td className="px-3 py-2 font-mono text-xs">{message.partition}</td>
                      <td className="truncate px-3 py-2 font-mono text-xs">{message.offset}</td>
                      <td className="truncate px-3 py-2 font-mono text-xs text-muted-foreground">{message.timestamp}</td>
                      <td className="truncate px-3 py-2 font-mono text-xs text-cyan-700 dark:text-cyan-300">
                        {message.key || <span className="text-muted-foreground">—</span>}
                      </td>
                      <td className="truncate px-3 py-2 font-mono text-xs">{valuePreview(message.value)}</td>
                      <td className="px-3 py-2">
                        <KafkaFormatBadge format={message.format} />
                      </td>
                    </tr>
                    {isExpanded && (
                      <tr>
                        <td colSpan={7} className="p-0">
                          <KafkaMessageDetail message={message} onExpand={() => setModalMessage(message)} />
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
          disabled={loadingOlder || deepScanning}
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

      <KafkaMessageModal message={modalMessage} onClose={() => setModalMessage(null)} />

      {menu && (
        <FloatingMenu x={menu.x} y={menu.y} onClose={() => setMenu(null)}>
          <FloatingMenuLabel>Open linked record</FloatingMenuLabel>
          {links.length === 0 && <FloatingMenuItem disabled>No links for this topic</FloatingMenuItem>}
          {links.map((link) => {
            const value = extractMessageField(menu.message.value, link.source_field ?? '')
            return (
              <FloatingMenuItem
                key={link.id}
                disabled={value === null}
                onClick={() => {
                  if (value !== null) {
                    onOpenLink(link, value)
                  }
                  setMenu(null)
                }}
              >
                {value === null ? `${linkTargetLabel(link, null)} (field missing)` : linkTargetLabel(link, value)}
              </FloatingMenuItem>
            )
          })}
          {reverseLinks.length > 0 && <FloatingMenuSeparator />}
          {reverseLinks.length > 0 && <FloatingMenuLabel>Back to source</FloatingMenuLabel>}
          {reverseLinks.map((link) => {
            const value = extractMessageField(menu.message.value, link.target_field ?? '')
            return (
              <FloatingMenuItem
                key={`rev-${link.id}`}
                disabled={value === null}
                onClick={() => {
                  if (value !== null) onOpenReverse(link, value)
                  setMenu(null)
                }}
              >
                {value === null ? `${linkSourceLabel(link, null)} (no value)` : linkSourceLabel(link, value)}
              </FloatingMenuItem>
            )
          })}
          <FloatingMenuSeparator />
          <FloatingMenuItem
            onClick={() => {
              onCreateLink(menu.message)
              setMenu(null)
            }}
          >
            + Create link…
          </FloatingMenuItem>
        </FloatingMenu>
      )}

      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Search the whole topic?</DialogTitle>
          </DialogHeader>
          <p className="text-xs text-muted-foreground">
            Scans the entire topic from newest to oldest in batches until a match is found or the beginning is
            reached. This can take a long time and many requests. You can cancel anytime.
          </p>
          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="ghost" size="sm" onClick={() => setConfirmOpen(false)}>
              Cancel
            </Button>
            <Button
              type="button"
              size="sm"
              onClick={() => {
                setConfirmOpen(false)
                onDeepScan(fieldInput, valueInput)
              }}
            >
              Continue
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {deepScanning && (
        <div className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-3 rounded-sm bg-background/85 backdrop-blur-sm">
          <Loader2 className="h-6 w-6 animate-spin text-orange-500" />
          <div className="font-mono text-xs text-muted-foreground">Deep scan · scanned {scanned.toLocaleString()}…</div>
          <Button type="button" size="sm" variant="outline" onClick={onCancelDeepScan}>
            Cancel
          </Button>
        </div>
      )}
    </div>
  )
}
