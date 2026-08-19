import { Fragment, useEffect, useMemo, useState, type FormEvent, type MouseEvent } from 'react'
import { ChevronDown, ChevronRight, ChevronsDown, Filter, Loader2, RefreshCw, Search, SlidersHorizontal, X } from 'lucide-react'
import { KafkaFormatBadge } from '@/components/kafka/KafkaFormatBadge'
import { KafkaMessageDetail } from '@/components/kafka/KafkaMessageDetail'
import { KafkaMessageModal } from '@/components/kafka/KafkaMessageModal'
import { JsonFieldPickerDialog } from '@/components/kafka/JsonFieldPickerDialog'
import { KafkaFilterDialog, emptyCondition } from '@/components/kafka/KafkaFilterDialog'
import { KafkaSeekControl } from '@/components/kafka/KafkaSeekControl'
import { EmptyState } from '@/components/EmptyState'
import {
  LINK_MENU_CAP,
  LINK_PREVIEW_CAP,
  LinkPickerDialog,
  type LinkPickerItem,
} from '@/components/links/LinkPickerDialog'
import { ErrorBanner } from '@/components/ErrorBanner'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { FloatingMenu, FloatingMenuItem, FloatingMenuLabel, FloatingMenuSeparator } from '@/components/ui/floating-menu'
import { extractMessageField, linkSourceLabel, linkSummary, linkTargetLabel } from '@/lib/links'
import { cn } from '@/lib/utils'
import {
  activeConditions,
  filterLoadedMessages,
  MAX_SCAN_MATCHES,
  type KafkaDirection,
  type KafkaMatchCondition,
  type KafkaMatchMode,
  type KafkaMessageRow,
  type KafkaSeek,
} from '@/stores/kafka'
import type { LinkRecord } from '@/types/api'

interface KafkaMessageBrowserProps {
  messages: KafkaMessageRow[]
  loading: boolean
  loadingOlder: boolean
  error: string | null
  hasMore: boolean
  partitionCount: number
  partitionFilter: number | null
  // Filter loaded (client-side).
  filterActive: boolean
  filterConditions: KafkaMatchCondition[]
  filterMode: KafkaMatchMode
  // Search topic (backend scan).
  searchActive: boolean
  searchConditions: KafkaMatchCondition[]
  searchMode: KafkaMatchMode
  scanning: boolean
  scanned: number
  scanPartial: boolean
  // The search stopped because it filled up on matches, not because the log ran
  // out. Continuing is not offered: there is nowhere to put more rows.
  scanLimitReached: boolean
  // Browse anchor — where reading starts. Composes with the search above rather
  // than replacing it: the seek narrows the range, the search narrows the rows.
  seek: KafkaSeek
  partitionsWindowed: number
  partitionsTotal: number
  // Which end of the log the tab reads from. Changes what "more" means, so it
  // also changes the paging button's wording.
  direction: KafkaDirection
  onPartitionChange: (partition: number | null) => void
  onSeekChange: (seek: KafkaSeek) => void
  onDirectionChange: (direction: KafkaDirection) => void
  onRefresh: () => void
  onLoadOlder: () => void
  onFilterLoaded: (conditions: KafkaMatchCondition[], mode: KafkaMatchMode) => void
  onClearFilter: () => void
  onSearchTopic: (conditions: KafkaMatchCondition[], mode: KafkaMatchMode) => void
  onScanMore: () => void
  onScanAll: () => void
  onCancelScanAll: () => void
  deepScanning: boolean
  deepScanCanceled: boolean
  onCancelScan: () => void
  onClearSearch: () => void
  links: LinkRecord[]
  onOpenLink: (link: LinkRecord, value: string) => void
  onCreateLink: (message: KafkaMessageRow) => void
  reverseLinks: LinkRecord[]
  onOpenReverse: (link: LinkRecord, value: string) => void
  // Point at this topic but cannot be walked back to their source.
  inboundOnlyLinks: LinkRecord[]
  // Links elsewhere on this connection: the preview set (what the menu does not
  // already list) and the full set the dialog shows.
  otherConnectionLinks: LinkRecord[]
  allConnectionLinks: LinkRecord[]
  connectionName: (connId: string) => string
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
  hasMore,
  partitionCount,
  partitionFilter,
  filterActive,
  filterConditions,
  filterMode,
  searchActive,
  searchConditions,
  searchMode,
  scanning,
  scanned,
  scanPartial,
  scanLimitReached,
  seek,
  partitionsWindowed,
  partitionsTotal,
  direction,
  onPartitionChange,
  onSeekChange,
  onDirectionChange,
  onRefresh,
  onLoadOlder,
  onFilterLoaded,
  onClearFilter,
  onSearchTopic,
  onScanMore,
  onScanAll,
  onCancelScanAll,
  deepScanning,
  deepScanCanceled,
  onCancelScan,
  onClearSearch,
  links,
  onOpenLink,
  onCreateLink,
  reverseLinks,
  onOpenReverse,
  inboundOnlyLinks,
  otherConnectionLinks,
  allConnectionLinks,
  connectionName,
}: KafkaMessageBrowserProps) {
  const [expanded, setExpanded] = useState<string | null>(null)
  const [modalMessage, setModalMessage] = useState<KafkaMessageRow | null>(null)
  // The draft the dialog edits. Applied only when Filter loaded or Search topic
  // runs, so opening the dialog and closing it changes nothing on screen.
  const [conditions, setConditions] = useState<KafkaMatchCondition[]>([{ ...emptyCondition }])
  const [mode, setMode] = useState<KafkaMatchMode>('and')
  const [filterDialogOpen, setFilterDialogOpen] = useState(false)
  // Which condition the field picker is filling.
  const [pickerIndex, setPickerIndex] = useState(0)
  const [menu, setMenu] = useState<{ x: number; y: number; message: KafkaMessageRow } | null>(null)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [pickerOpen, setPickerOpen] = useState(false)
  // The message is captured alongside the group: opening the dialog closes the
  // floating menu, and the topic/reverse lists resolve their values from it.
  const [linkPicker, setLinkPicker] = useState<{
    group: 'topic' | 'reverse' | 'connection'
    message: KafkaMessageRow | null
  } | null>(null)

  // Seed the draft when a search is set programmatically (e.g. a link jump
  // populates the topic scan) so the user sees and can refine what is being
  // searched. Guarded on a non-empty set so clearing a search never wipes what
  // the user typed.
  useEffect(() => {
    if (searchConditions.length > 0) {
      setConditions(searchConditions)
      setMode(searchMode)
    }
  }, [searchConditions, searchMode])

  // The visible table rows: raw loaded messages, narrowed by the client-side
  // "Filter loaded" predicate when one is applied. During a topic search the
  // messages ARE the scan matches and no client filter applies.
  const visibleMessages = useMemo(
    () => (filterActive ? filterLoadedMessages(messages, filterConditions, filterMode) : messages),
    [filterActive, filterConditions, filterMode, messages]
  )

  const linkPickerItems = useMemo<LinkPickerItem[]>(() => {
    if (!linkPicker) return []
    const message = linkPicker.message
    if (linkPicker.group === 'topic' && message) {
      return links.map((link) => {
        const value = extractMessageField(message.value, link.source_field ?? '')
        return {
          id: link.id,
          label: value === null ? `${linkTargetLabel(link, null)} (field missing)` : linkTargetLabel(link, value),
          disabled: value === null,
          onPick: () => {
            if (value !== null) onOpenLink(link, value)
          },
        }
      })
    }
    if (linkPicker.group === 'reverse' && message) {
      return reverseLinks.map((link) => {
        const value = extractMessageField(message.value, link.target_field ?? '')
        return {
          id: link.id,
          label: value === null ? `${linkSourceLabel(link, null)} (no value)` : linkSourceLabel(link, value),
          disabled: value === null,
          onPick: () => {
            if (value !== null) onOpenReverse(link, value)
          },
        }
      })
    }
    // Reference only: these belong to other topics, so this message holds no
    // value to follow them with.
    return allConnectionLinks.map((link) => ({
      id: link.id,
      label: linkSummary(link, connectionName),
      disabled: true,
      onPick: () => undefined,
    }))
  }, [linkPicker, links, reverseLinks, allConnectionLinks, connectionName, onOpenLink, onOpenReverse])

  // Clearing means the query is gone, dialog included — the Filters badge
  // counts what the dialog holds, so a leftover draft read as a filter that was
  // still on.
  const resetDraft = (clear: () => void) => () => {
    clear()
    setConditions([{ ...emptyCondition }])
    setMode('and')
  }

  const openMenu = (event: MouseEvent, message: KafkaMessageRow) => {
    event.preventDefault()
    setMenu({ x: event.clientX, y: event.clientY, message })
  }

  const readyConditions = activeConditions(conditions)
  const canFilter = readyConditions.length > 0 && !searchActive && messages.length > 0
  const canSearch = readyConditions.length > 0 && !scanning

  // Enter applies the cheap, instant client-side filter — never the expensive
  // topic scan, which stays an explicit, confirmed button click.
  const submitFilter = (event: FormEvent) => {
    event.preventDefault()
    if (!canFilter) return
    onFilterLoaded(readyConditions, mode)
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

          <span className="mx-1 h-4 w-px bg-border" aria-hidden="true" />

          <KafkaSeekControl
            seek={seek}
            partitionFilter={partitionFilter}
            partitionsWindowed={partitionsWindowed}
            partitionsTotal={partitionsTotal}
            disabled={loading || scanning}
            onApply={onSeekChange}
          />

          <span className="mx-1 h-4 w-px bg-border" aria-hidden="true" />

          {/* Which end of the log to read from. Two states, so a segmented pair
              keeps the current one visible without opening anything. */}
          <div className="flex items-center rounded-sm border border-border p-0.5" role="group" aria-label="Read order">
            {(['newest', 'oldest'] as const).map((option) => (
              <button
                key={option}
                type="button"
                aria-pressed={direction === option}
                disabled={loading || scanning}
                onClick={() => onDirectionChange(option)}
                className={cn(
                  'rounded-[2px] px-2 py-0.5 font-mono text-[11px] transition-colors disabled:opacity-50',
                  direction === option ? 'bg-orange-500/15 text-orange-500' : 'text-muted-foreground hover:text-foreground'
                )}
              >
                {option === 'newest' ? 'Newest' : 'Oldest'}
              </button>
            ))}
          </div>
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
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="h-8 gap-1.5 font-mono text-[11px]"
          onClick={() => setFilterDialogOpen(true)}
          title="Build the conditions a message must satisfy"
        >
          <SlidersHorizontal className="h-3.5 w-3.5" />
          Filters
          {readyConditions.length > 0 && (
            <span className="rounded-sm border border-orange-500/30 bg-orange-500/5 px-1.5 text-[10px] uppercase tracking-[0.12em] text-orange-600 dark:text-orange-400">
              {readyConditions.length}
              {readyConditions.length > 1 ? ` ${mode}` : ''}
            </span>
          )}
        </Button>
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

      <KafkaFilterDialog
        open={filterDialogOpen}
        conditions={conditions}
        mode={mode}
        onOpenChange={setFilterDialogOpen}
        onConditionsChange={setConditions}
        onModeChange={setMode}
        onPickField={(index) => {
          setPickerIndex(index)
          setPickerOpen(true)
        }}
      />

      {filterActive && (
        <div className="flex flex-wrap items-center gap-2 font-mono text-[11px] text-muted-foreground">
          <span>
            Filtered {messages.length.toLocaleString()} loaded messages · {visibleMessages.length.toLocaleString()} matches
          </span>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="h-6 gap-1 px-1.5 font-mono text-[11px]"
            onClick={resetDraft(onClearFilter)}
          >
            <X className="h-3 w-3" />
            Clear filter
          </Button>
        </div>
      )}

      {searchActive && (
        <div className="flex flex-wrap items-center gap-2 font-mono text-[11px] text-muted-foreground">
          {scanning && <Loader2 className="h-3 w-3 animate-spin text-orange-500" />}
          <span>
            {scanning || deepScanning ? 'Scanning… ' : ''}Scanned {scanned.toLocaleString()} ·{' '}
            {messages.length.toLocaleString()} matches
            {!scanning && !deepScanning && deepScanCanceled && hasMore && ' · canceled'}
            {/* The match ceiling outranks the budget note: both mean "stopped
                early", but this one also explains why there is no way to
                continue, so saying anything else here would be misleading. */}
            {!scanning && !deepScanning && !deepScanCanceled && scanLimitReached && ' · stopped at the match limit'}
            {!scanning && !deepScanning && !deepScanCanceled && !scanLimitReached && scanPartial && ' · stopped at scan budget'}
            {!scanning && !deepScanning && !scanLimitReached && !hasMore && (direction === 'oldest' ? ' · reached end' : ' · reached beginning')}
          </span>
          {scanning || deepScanning ? (
            // Во время автопрохода эта кнопка обязана значить то же, что и
            // большая внизу: оборвать ВЕСЬ цикл. Иначе она гасила бы только
            // текущий шаг, а цикл шёл бы дальше — два «Cancel» с разным смыслом.
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-6 gap-1 px-1.5 font-mono text-[11px]"
              onClick={deepScanning ? onCancelScanAll : onCancelScan}
            >
              <X className="h-3 w-3" />
              Cancel
            </Button>
          ) : (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-6 gap-1 px-1.5 font-mono text-[11px]"
              onClick={resetDraft(onClearSearch)}
            >
              <X className="h-3 w-3" />
              Clear search
            </Button>
          )}
        </div>
      )}

      {error && <ErrorBanner message={error} onRetry={onRefresh} />}

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

      {hasMore &&
        (searchActive ? (
          deepScanning ? (
            // Во время автоцикла единственное осмысленное действие — прервать
            // его: найденное и счётчик прочитанного остаются на экране.
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-8 w-full gap-1.5 font-mono text-[11px]"
              onClick={onCancelScanAll}
            >
              <X className="h-3.5 w-3.5" />
              Cancel · scanned {scanned.toLocaleString()}
            </Button>
          ) : scanLimitReached ? (
            // Продолжать некуда: место под результаты кончилось, а не лог.
            // Кнопки убраны, потому что нажатие всё равно не добавило бы ни
            // одной строки — вместо этого написано, что делать дальше.
            <p className="rounded-sm border border-border/70 bg-muted/20 px-3 py-2 font-mono text-[11px] text-muted-foreground">
              Stopped at {MAX_SCAN_MATCHES.toLocaleString()} matches. Narrow the search — by value, partition or seek — to
              look further into the log.
            </p>
          ) : (
            <div className="flex gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-8 flex-1 gap-1.5 font-mono text-[11px]"
                disabled={scanning}
                onClick={onScanMore}
              >
                {scanning ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ChevronsDown className="h-3.5 w-3.5" />}
                {scanning ? 'Scanning…' : 'Scan more'}
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-8 flex-1 gap-1.5 font-mono text-[11px]"
                disabled={scanning}
                onClick={onScanAll}
                title="Keep scanning older messages until the beginning of the log. Cancel anytime — matches found so far stay."
              >
                <ChevronsDown className="h-3.5 w-3.5" />
                Search all
              </Button>
            </div>
          )
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
            {loadingOlder
              ? direction === 'oldest'
                ? 'Loading newer messages…'
                : 'Loading older messages…'
              : direction === 'oldest'
                ? 'Load newer messages'
                : 'Load older messages'}
          </Button>
        ))}

      <KafkaMessageModal message={modalMessage} onClose={() => setModalMessage(null)} />

      <JsonFieldPickerDialog
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        messages={messages}
        onUseField={(path) =>
          setConditions((current) =>
            current.map((condition, at) => (at === pickerIndex ? { ...condition, field: path } : condition))
          )
        }
      />

      <LinkPickerDialog
        open={linkPicker !== null}
        onOpenChange={(next) => {
          if (!next) setLinkPicker(null)
        }}
        title={
          linkPicker?.group === 'reverse'
            ? 'Back to source'
            : linkPicker?.group === 'connection'
            ? 'Links on this connection'
            : 'Open linked record'
        }
        items={linkPickerItems}
      />

      {menu && (
        <FloatingMenu x={menu.x} y={menu.y} onClose={() => setMenu(null)}>
          <FloatingMenuLabel>Open linked record</FloatingMenuLabel>
          {/* Scoped to this group, which lists only links whose SOURCE is this
              topic. Saying "no links for this topic" claimed more than the
              group knows, and contradicted the inbound and elsewhere groups
              right below it. */}
          {links.length === 0 && <FloatingMenuItem disabled>No links from this topic</FloatingMenuItem>}
          {links.slice(0, LINK_MENU_CAP).map((link) => {
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
          {links.length > LINK_MENU_CAP && (
            <FloatingMenuItem
              onClick={() => {
                setLinkPicker({ group: 'topic', message: menu.message })
                setMenu(null)
              }}
            >
              {`Show all (${links.length})…`}
            </FloatingMenuItem>
          )}
          {reverseLinks.length > 0 && <FloatingMenuSeparator />}
          {reverseLinks.length > 0 && <FloatingMenuLabel>Back to source</FloatingMenuLabel>}
          {reverseLinks.slice(0, LINK_MENU_CAP).map((link) => {
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
          {reverseLinks.length > LINK_MENU_CAP && (
            <FloatingMenuItem
              onClick={() => {
                setLinkPicker({ group: 'reverse', message: menu.message })
                setMenu(null)
              }}
            >
              {`Show all (${reverseLinks.length})…`}
            </FloatingMenuItem>
          )}
          {/* Point at this topic but cannot be walked back to their source, so
              they are shown, not followed. */}
          {inboundOnlyLinks.length > 0 && <FloatingMenuSeparator />}
          {inboundOnlyLinks.length > 0 && <FloatingMenuLabel>Points here · not reversible</FloatingMenuLabel>}
          {inboundOnlyLinks.slice(0, LINK_MENU_CAP).map((link) => (
            <FloatingMenuItem key={`in-${link.id}`} disabled>
              {linkSummary(link, connectionName)}
            </FloatingMenuItem>
          ))}
          {/* What else this connection is wired to. Reference only -- these
              belong to other topics, so this message has no value to follow
              them with -- but without them a topic with no links of its own
              looked like a connection with none. */}
          {/* The separator belongs to the whole connection block, not just its
              preview: when every link on the connection is already listed above,
              the preview is empty but "Show all" still needs to stand apart. */}
          {allConnectionLinks.length > 0 && <FloatingMenuSeparator />}
          {otherConnectionLinks.length > 0 && <FloatingMenuLabel>Elsewhere on this connection</FloatingMenuLabel>}
          {otherConnectionLinks.slice(0, LINK_PREVIEW_CAP).map((link) => (
            <FloatingMenuItem key={`conn-${link.id}`} disabled>
              {linkSummary(link, connectionName)}
            </FloatingMenuItem>
          ))}
          {allConnectionLinks.length > 0 && (
            <FloatingMenuItem
              onClick={() => {
                setLinkPicker({ group: 'connection', message: null })
                setMenu(null)
              }}
            >
              {`Show all ${allConnectionLinks.length} on this connection…`}
            </FloatingMenuItem>
          )}
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
                onSearchTopic(readyConditions, mode)
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
