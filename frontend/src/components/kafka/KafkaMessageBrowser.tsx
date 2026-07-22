import { Fragment, useEffect, useMemo, useState, type FormEvent, type MouseEvent } from 'react'
import { ChevronDown, ChevronRight, ChevronsDown, Filter, ListTree, Loader2, RefreshCw, Search, X } from 'lucide-react'
import { KafkaCoverageBanner } from '@/components/kafka/KafkaCoverageBanner'
import { KafkaFormatBadge } from '@/components/kafka/KafkaFormatBadge'
import { KafkaMessageDetail } from '@/components/kafka/KafkaMessageDetail'
import { KafkaMessageModal } from '@/components/kafka/KafkaMessageModal'
import { JsonFieldPickerDialog } from '@/components/kafka/JsonFieldPickerDialog'
import { EmptyState } from '@/components/EmptyState'
import { ErrorBanner } from '@/components/ErrorBanner'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { FloatingMenu, FloatingMenuItem, FloatingMenuLabel, FloatingMenuSeparator } from '@/components/ui/floating-menu'
import { extractMessageField, linkSourceLabel, linkTargetLabel } from '@/lib/links'
import { cn } from '@/lib/utils'
import { filterLoadedMessages, type KafkaMessageRow } from '@/stores/kafka'
import type { LinkRecord } from '@/types/api'

interface KafkaMessageBrowserProps {
  messages: KafkaMessageRow[]
  loading: boolean
  loadingOlder: boolean
  error: string | null
  hasOlder: boolean
  partitionCount: number
  partitionFilter: number | null
  // Filter loaded (client-side).
  filterActive: boolean
  filterField: string
  filterValue: string
  // Search topic (backend scan).
  searchActive: boolean
  searchField: string
  searchValue: string
  scanning: boolean
  scanned: number
  scanPartial: boolean
  // Browse-coverage (Task 4) — distinct from scanPartial above.
  partial: boolean
  partialReason: string | null
  partitionsTotal: number
  partitionsCompleted: number
  onPartitionChange: (partition: number | null) => void
  onRefresh: () => void
  onLoadOlder: () => void
  onFilterLoaded: (field: string, value: string) => void
  onClearFilter: () => void
  onSearchTopic: (field: string, value: string) => void
  onScanMore: () => void
  onCancelScan: () => void
  onClearSearch: () => void
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
  filterActive,
  filterField,
  filterValue,
  searchActive,
  searchField,
  searchValue,
  scanning,
  scanned,
  scanPartial,
  partial,
  partialReason,
  partitionsTotal,
  partitionsCompleted,
  onPartitionChange,
  onRefresh,
  onLoadOlder,
  onFilterLoaded,
  onClearFilter,
  onSearchTopic,
  onScanMore,
  onCancelScan,
  onClearSearch,
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
  const [pickerOpen, setPickerOpen] = useState(false)

  // Seed the editable inputs when a search is set programmatically (e.g. a link
  // jump populates the topic scan) so the user sees and can refine what's being
  // searched. Guarded on a non-empty field so clearing a search never wipes what
  // the user typed.
  useEffect(() => {
    if (searchField) {
      setFieldInput(searchField)
      setValueInput(searchValue)
    }
  }, [searchField, searchValue])

  // The visible table rows: raw loaded messages, narrowed by the client-side
  // "Filter loaded" predicate when one is applied. During a topic search the
  // messages ARE the scan matches and no client filter applies.
  const visibleMessages = useMemo(
    () => (filterActive ? filterLoadedMessages(messages, filterField, filterValue) : messages),
    [filterActive, filterField, filterValue, messages]
  )

  const openMenu = (event: MouseEvent, message: KafkaMessageRow) => {
    event.preventDefault()
    setMenu({ x: event.clientX, y: event.clientY, message })
  }

  const canFilter = Boolean(fieldInput.trim()) && !searchActive && messages.length > 0
  const canSearch = Boolean(fieldInput.trim()) && !scanning

  // Enter applies the cheap, instant client-side filter — never the expensive
  // topic scan, which stays an explicit, confirmed button click.
  const submitFilter = (event: FormEvent) => {
    event.preventDefault()
    if (!canFilter) return
    onFilterLoaded(fieldInput, valueInput)
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
        <div className="flex items-center gap-2">
          {loading && messages.length > 0 && (
            <span className="flex items-center gap-1.5 font-mono text-[10px] text-muted-foreground">
              <Loader2 className="h-3 w-3 animate-spin" />
              Refreshing…
            </span>
          )}
          <Button type="button" size="sm" variant="outline" className="h-8 gap-1.5 font-mono text-[11px]" onClick={onRefresh} disabled={loading || scanning}>
            <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />
            Refresh
          </Button>
        </div>
      </div>

      <form onSubmit={submitFilter} className="flex flex-wrap items-center gap-2">
        <input
          value={fieldInput}
          onChange={(event) => setFieldInput(event.target.value)}
          placeholder="JSON path (e.g. events[].name)"
          aria-label="JSON field path"
          title="Nested paths and arrays are supported, for example events[].name"
          spellCheck={false}
          autoComplete="off"
          className="h-8 w-56 rounded-sm border border-border bg-background px-2 font-mono text-xs outline-none placeholder:text-muted-foreground focus:border-orange-500/50"
        />
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="h-8 gap-1.5 font-mono text-[11px]"
          onClick={() => setPickerOpen(true)}
          title="Browse sampled messages and pick a field"
        >
          <ListTree className="h-3.5 w-3.5" />
          Choose field
        </Button>
        <input
          value={valueInput}
          onChange={(event) => setValueInput(event.target.value)}
          placeholder="equals value"
          aria-label="Expected JSON field value"
          spellCheck={false}
          autoComplete="off"
          className="h-8 w-44 rounded-sm border border-border bg-background px-2 font-mono text-xs outline-none placeholder:text-muted-foreground focus:border-orange-500/50"
        />
        <Button
          type="submit"
          size="sm"
          variant="outline"
          className="h-8 gap-1.5 font-mono text-[11px]"
          disabled={!canFilter}
          title="Filter the messages already loaded below — instant, no request"
        >
          <Filter className="h-3.5 w-3.5" />
          Filter loaded
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="h-8 gap-1.5 font-mono text-[11px]"
          disabled={!canSearch}
          onClick={() => setConfirmOpen(true)}
          title="Scan the whole topic on the server — slower, one request per step"
        >
          <Search className="h-3.5 w-3.5" />
          Search topic
        </Button>
      </form>

      {filterActive && (
        <div className="flex flex-wrap items-center gap-2 font-mono text-[11px] text-muted-foreground">
          <span>
            Filtered {messages.length.toLocaleString()} loaded messages · {visibleMessages.length.toLocaleString()} matches
          </span>
          <Button type="button" size="sm" variant="ghost" className="h-6 gap-1 px-1.5 font-mono text-[11px]" onClick={onClearFilter}>
            <X className="h-3 w-3" />
            Clear filter
          </Button>
        </div>
      )}

      {searchActive && (
        <div className="flex flex-wrap items-center gap-2 font-mono text-[11px] text-muted-foreground">
          {scanning && <Loader2 className="h-3 w-3 animate-spin text-orange-500" />}
          <span>
            {scanning ? 'Scanning… ' : ''}Scanned {scanned.toLocaleString()} · {messages.length.toLocaleString()} matches
            {!scanning && scanPartial && ' · stopped at scan budget'}
            {!scanning && !hasOlder && ' · reached beginning'}
          </span>
          {scanning ? (
            <Button type="button" size="sm" variant="outline" className="h-6 gap-1 px-1.5 font-mono text-[11px]" onClick={onCancelScan}>
              <X className="h-3 w-3" />
              Cancel
            </Button>
          ) : (
            <Button type="button" size="sm" variant="ghost" className="h-6 gap-1 px-1.5 font-mono text-[11px]" onClick={onClearSearch}>
              <X className="h-3 w-3" />
              Clear search
            </Button>
          )}
        </div>
      )}

      {error && <ErrorBanner message={error} onRetry={onRefresh} />}

      {partial && !searchActive && (
        <KafkaCoverageBanner
          messageCount={messages.length}
          partitionsCompleted={partitionsCompleted}
          partitionsTotal={partitionsTotal}
          reason={partialReason}
        />
      )}

      {!error && visibleMessages.length === 0 && !loading && !scanning ? (
        <EmptyState
          variant="no_tables"
          compact
          title={searchActive ? 'No matches' : filterActive ? 'No loaded matches' : 'No messages'}
          description={
            searchActive
              ? 'No messages matched the scanned windows. Try “Scan more” to look deeper.'
              : filterActive
                ? 'No loaded messages match this filter. Adjust the path or value, or clear the filter.'
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
              {visibleMessages.map((message) => {
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

      {hasOlder &&
        (searchActive ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-8 w-full gap-1.5 font-mono text-[11px]"
            disabled={scanning}
            onClick={onScanMore}
          >
            {scanning ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ChevronsDown className="h-3.5 w-3.5" />}
            {scanning ? 'Scanning…' : 'Scan more'}
          </Button>
        ) : (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-8 w-full gap-1.5 font-mono text-[11px]"
            disabled={loadingOlder}
            onClick={onLoadOlder}
          >
            {loadingOlder ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ChevronsDown className="h-3.5 w-3.5" />}
            {loadingOlder ? 'Loading older messages…' : 'Load older messages'}
          </Button>
        ))}

      <KafkaMessageModal message={modalMessage} onClose={() => setModalMessage(null)} />

      <JsonFieldPickerDialog
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        messages={messages}
        onUseField={(path) => setFieldInput(path)}
      />

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
            Scans the topic on the server from newest to oldest, one budgeted step at a time, and shows matches as
            they are found. Each step is a request that can take several seconds. Continue deeper with “Scan more”,
            and cancel a running step anytime.
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
                onSearchTopic(fieldInput, valueInput)
              }}
            >
              Search topic
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
