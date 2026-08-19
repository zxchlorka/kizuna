import { useCallback, useEffect, useMemo, useState, type MouseEvent } from 'react'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Binary, Copy as CopyIcon, KeyRound, Link2, Lock, PenLine, RefreshCw, TimerReset, Trash2 } from 'lucide-react'
import { EmptyState } from '@/components/EmptyState'
import { ErrorBanner } from '@/components/ErrorBanner'
import { LoadingSkeleton } from '@/components/LoadingSkeleton'
import { DeleteKeyDialog } from '@/components/redis/DeleteKeyDialog'
import { RenameKeyDialog } from '@/components/redis/RenameKeyDialog'
import { SetTTLDialog } from '@/components/redis/SetTTLDialog'
import { HashEditor } from '@/components/redis/editors/HashEditor'
import { JsonEditor } from '@/components/redis/editors/JsonEditor'
import { ListEditor } from '@/components/redis/editors/ListEditor'
import { SetEditor } from '@/components/redis/editors/SetEditor'
import { SortedSetEditor } from '@/components/redis/editors/SortedSetEditor'
import { StringEditor } from '@/components/redis/editors/StringEditor'
import { StreamViewer } from '@/components/redis/editors/StreamViewer'
import {
  formatRedisTTL,
  getRedisObjectTypeLabel,
  getRedisTypePillClass,
  getRedisTTLStyle,
  normalizeRedisObjectType,
  redisValueCellAt,
  stringifyRedisValue,
} from '@/components/redis/redisUtils'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { CreateLinkDialog } from '@/components/links/CreateLinkDialog'
import { LINK_MENU_CAP, LinkPickerDialog, type LinkPickerItem } from '@/components/links/LinkPickerDialog'
import {
  FloatingMenu,
  FloatingMenuItem,
  FloatingMenuLabel,
  FloatingMenuSeparator,
} from '@/components/ui/floating-menu'
import { useOpenLinkSource, useOpenLinkTarget } from '@/hooks/useOpenLink'
import {
  canReverse,
  captureFromKey,
  extractRedisValue,
  isPerElementExtract,
  keyLevelRedisLinks,
  linkSourceLabel,
  linkSummary,
  linkTargetLabel,
  memberRedisLinks,
  redisKeyMatchesPattern,
  selectionRedisLinks,
  suggestKeyPattern,
} from '@/lib/links'
import { trimToken, valueAtPoint } from '@/lib/textSelection'
import { formatBytes } from '@/lib/numberFormat'
import { cn } from '@/lib/utils'
import { useConnectionStore } from '@/stores/connections'
import { useDataStore } from '@/stores/data'
import { useLinksStore } from '@/stores/links'
import { useToastStore } from '@/stores/toast'
import { useWorkspaceStore } from '@/stores/workspace'
import type { ObjectType } from '@/types/api'

interface RedisKeyViewProps {
  connId: string
  tabId: string
  object: string
  objectType: ObjectType
  ttlSeconds?: number | null
}

export function RedisKeyView({ connId, tabId, object, objectType, ttlSeconds }: RedisKeyViewProps) {
  const connections = useConnectionStore((state) => state.connections)
  const connection = connections.find((item) => item.id === connId)
  // Both ends of a link are named: the far end is usually a different
  // connection, and the summary is otherwise ambiguous between servers.
  const connectionName = useCallback(
    (id: string) => connections.find((item) => item.id === id)?.name ?? id,
    [connections]
  )
  const tabData = useDataStore((state) => state.tabs[tabId])
  const fetchData = useDataStore((state) => state.fetchData)
  const mutate = useDataStore((state) => state.mutate)
  const setOpts = useDataStore((state) => state.setOpts)
  const refreshTree = useWorkspaceStore((state) => state.refreshTree)
  const closeTab = useWorkspaceStore((state) => state.closeTab)
  const pushToast = useToastStore((state) => state.push)
  const openTab = useWorkspaceStore((state) => state.openTab)

  const [saving, setSaving] = useState(false)
  const [ttlDialogOpen, setTTLDialogOpen] = useState(false)
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false)
  const [copyOpen, setCopyOpen] = useState(false)
  const [copyName, setCopyName] = useState('')
  const [copying, setCopying] = useState(false)
  const [renameOpen, setRenameOpen] = useState(false)
  const [renaming, setRenaming] = useState(false)

  // The key under this tab stops existing, so the tab has to follow it: the new
  // name is opened first and the old tab closed after, which leaves the new one
  // active instead of dropping the user onto a neighbouring tab.
  const renameKey = async (destination: string) => {
    if (renaming) {
      return
    }
    setRenaming(true)
    try {
      await mutate(connId, { type: 'rename', object, schema: '', where: {}, data: { destination } }, tabId, {
        reload: false,
      })
      setRenameOpen(false)
      pushToast({ tone: 'success', title: 'Key renamed', message: destination })
      openTab(connId, destination, objectType)
      closeTab(tabId)
      await refreshTree(connId)
    } catch (error) {
      pushToast({ tone: 'error', title: 'Rename failed', message: (error as Error).message })
    } finally {
      setRenaming(false)
    }
  }

  // The copy is made server-side from the stored value, so the new key is a
  // faithful duplicate of whatever type this is — no reading the contents into
  // the browser and writing them back field by field.
  const duplicateKey = async () => {
    const destination = copyName.trim()
    if (!destination || copying) {
      return
    }
    setCopying(true)
    try {
      await mutate(connId, { type: 'copy', object, schema: '', where: {}, data: { destination } }, tabId, { reload: false })
      setCopyOpen(false)
      pushToast({ tone: 'success', title: 'Key duplicated', message: destination })
      openTab(connId, destination, objectType)
    } catch (error) {
      pushToast({ tone: 'error', title: 'Duplicate failed', message: (error as Error).message })
    } finally {
      setCopying(false)
    }
  }

  const links = useLinksStore((state) => state.links)
  const fetchLinks = useLinksStore((state) => state.fetch)
  const openLinkTarget = useOpenLinkTarget()
  const [createLinkOpen, setCreateLinkOpen] = useState(false)
  // Непусто, когда диалог открыт из меню элемента: предзаполняет режим selection
  // и поле, по которому кликнули.
  const [createFromElement, setCreateFromElement] = useState<{ field?: string } | null>(null)
  const [pickerGroup, setPickerGroup] = useState<
    'key' | 'reverse' | 'perElement' | 'member' | 'selection' | null
  >(null)

  useEffect(() => {
    void fetchData(connId, object, tabId)
  }, [connId, fetchData, object, tabId])

  useEffect(() => {
    void fetchLinks().catch(() => undefined)
  }, [fetchLinks])

  const keyLinks = useMemo(() => keyLevelRedisLinks(links, connId, object), [links, connId, object])
  const memberLinks = useMemo(() => memberRedisLinks(links, connId, object), [links, connId, object])

  const [memberMenu, setMemberMenu] = useState<{
    x: number
    y: number
    member: string
    field?: string
    token: string | null
  } | null>(null)

  // Линки, применимые к точке, по которой кликнули: у хэша это поле строки,
  // у коллекций поля нет и подходят только линки без source_field.
  const elementSelectionLinks = useMemo(
    () => selectionRedisLinks(links, connId, object, memberMenu?.field),
    [links, connId, object, memberMenu?.field]
  )

  // Для справочной группы в шапке нужны ВСЕ per-element линки ключа, независимо
  // от поля — пользователь должен видеть, что линк существует. Поэтому здесь
  // прямой фильтр, а не selectionRedisLinks: тот сузил бы список до линков без
  // source_field.
  const perElementLinks = useMemo(
    () =>
      links.filter(
        (link) =>
          link.source_conn_id === connId &&
          link.source_kind === 'redis' &&
          isPerElementExtract(link.source_extract) &&
          redisKeyMatchesPattern(link.source_scope, object)
      ),
    [links, connId, object]
  )

  const handleElementContextMenu = (value: string, event: MouseEvent, field?: string) => {
    event.preventDefault()
    // Хиттест ограничен ячейкой со значением, а не всей строкой (см.
    // redisValueCellAt): меню по-прежнему открывается по ПКМ в любом месте
    // строки и знает её member, но «фрагмент под курсором» берётся только из
    // значения. Клик мимо неё — по имени поля, индексу, score, кнопке — даёт
    // null, и пункт «Open from …» остаётся выключенным.
    const valueCell = redisValueCellAt(event.target)
    setMemberMenu({
      x: event.clientX,
      y: event.clientY,
      member: value,
      field,
      // Значение фрагмента считается в момент клика: позже выделение может
      // слететь от самого открытия меню.
      token: valueCell ? valueAtPoint(event.clientX, event.clientY, valueCell) : null,
    })
  }

  // Строковое значение живёт в textarea: там нет текстовых узлов, по которым
  // работает caret-хиттест, поэтому значение берётся только из собственного
  // выделения поля.
  const handleStringContextMenu = (selected: string, event: MouseEvent) => {
    event.preventDefault()
    const token = trimToken(selected)
    setMemberMenu({
      x: event.clientX,
      y: event.clientY,
      member: selected,
      field: undefined,
      token: token === '' ? null : token,
    })
  }

  const openLinkSource = useOpenLinkSource()
  const reverseLinks = useMemo(
    () =>
      links.filter(
        (link) =>
          link.target_conn_id === connId &&
          link.target_kind === 'redis' &&
          redisKeyMatchesPattern(link.key_pattern ?? '', object) &&
          canReverse(link)
      ),
    [links, connId, object]
  )

  // Point at this key but cannot be walked back to their source: shown, not followed.
  const inboundOnlyLinks = useMemo(
    () =>
      links.filter(
        (link) =>
          link.target_conn_id === connId &&
          link.target_kind === 'redis' &&
          redisKeyMatchesPattern(link.key_pattern ?? '', object) &&
          !canReverse(link)
      ),
    [links, connId, object]
  )
  const rows = useMemo(() => tabData?.rows ?? [], [tabData?.rows])
  const stringValue = useMemo(() => stringifyRedisValue(rows[0]?.value), [rows])

  // Полный список группы для модалки: в меню помещается только LINK_MENU_CAP
  // пунктов, здесь — всё, с полными метками.
  const pickerItems = useMemo<LinkPickerItem[]>(() => {
    if (pickerGroup === 'key') {
      return keyLinks.map((link) => {
        const value = extractRedisValue(link, object, stringValue, rows)
        return {
          id: link.id,
          label: value === null ? `${linkTargetLabel(link, null)} (no value)` : linkTargetLabel(link, value),
          disabled: value === null,
          onPick: () => {
            if (value !== null) openLinkTarget(link, value)
          },
        }
      })
    }
    if (pickerGroup === 'reverse') {
      return reverseLinks.map((link) => {
        const value = captureFromKey(link.key_pattern ?? '', object)
        return {
          id: link.id,
          label: value === null ? `${linkSourceLabel(link, null)} (no value)` : linkSourceLabel(link, value),
          disabled: value === null,
          onPick: () => {
            if (value !== null) openLinkSource(link, value)
          },
        }
      })
    }
    if (pickerGroup === 'perElement') {
      return perElementLinks.map((link) => ({
        id: link.id,
        label: linkSummary(link),
        disabled: true,
        onPick: () => undefined,
      }))
    }
    if (pickerGroup === 'member' && memberMenu) {
      const member = memberMenu.member
      return memberLinks.map((link) => ({
        id: link.id,
        label: linkTargetLabel(link, member),
        onPick: () => {
          openLinkTarget(link, member)
          setMemberMenu(null)
        },
      }))
    }
    if (pickerGroup === 'selection' && memberMenu) {
      const token = memberMenu.token
      return elementSelectionLinks.map((link) => ({
        id: link.id,
        label: linkTargetLabel(link, token),
        disabled: token === null,
        onPick: () => {
          if (token !== null) {
            openLinkTarget(link, token)
            setMemberMenu(null)
          }
        },
      }))
    }
    return []
  }, [
    pickerGroup,
    keyLinks,
    reverseLinks,
    perElementLinks,
    memberLinks,
    elementSelectionLinks,
    memberMenu,
    object,
    stringValue,
    rows,
    openLinkTarget,
    openLinkSource,
  ])

  const hashFieldNames = useMemo(
    () => rows.map((r) => String(r.field ?? '')).filter((name) => name !== ''),
    [rows]
  )
  const columns = tabData?.columns ?? []
  const loading = tabData?.loading ?? false
  const error = tabData?.error ?? null
  const total = tabData?.total ?? 0
  const opts = tabData?.opts
  const meta = tabData?.meta ?? {}

  const metaType = typeof meta.type === 'string' ? meta.type : undefined
  // Sampled by Redis on large collections, so it is an estimate — worth showing
  // because "which key is eating the memory" has no other answer in the UI.
  const memoryBytes = typeof meta.memory_bytes === 'number' ? meta.memory_bytes : null
  const normalizedType = normalizeRedisObjectType(metaType ?? objectType)
  const currentTTL = typeof meta.ttl === 'number' ? meta.ttl : (ttlSeconds ?? null)
  const ttlLabel = formatRedisTTL(currentTTL)
  const isJson = Boolean(meta.is_json)
  const hasBinary = Boolean(meta.has_binary)
  const readOnly = connection?.read_only ?? false
  // Значение не UTF-8: бэкенд отдал его в escape-форме \xNN. Записать этот текст
  // обратно как обычную строку значило бы уничтожить исходные байты, поэтому
  // правки значений запрещаются. Удаление ключа и смена TTL при этом безопасны и
  // остаются доступными — отсюда отдельный флаг, а не общий readOnly.
  const valueEditingDisabled = readOnly || hasBinary

  const refresh = async () => {
    await fetchData(connId, object, tabId)
    await refreshTree(connId)
  }

  const runMutation = async (payload: {
    type: 'insert' | 'update' | 'delete'
    where?: Record<string, unknown>
    data?: Record<string, unknown>
  }) => {
    if (readOnly) {
      pushToast({ tone: 'error', title: 'Read-only connection', message: 'Writes are disabled for this connection.' })
      return
    }
    setSaving(true)
    try {
      await mutate(connId, {
        type: payload.type,
        schema: '',
        object,
        where: payload.where,
        data: payload.data,
      }, tabId, { reload: false })
      await fetchData(connId, object, tabId)
      await refreshTree(connId)
    } catch (mutationError) {
      pushToast({
        tone: 'error',
        title: 'Redis mutation failed',
        message: (mutationError as Error).message,
      })
      throw mutationError
    } finally {
      setSaving(false)
    }
  }

  const listOffset = opts?.offset ?? 0
  const listLimit = opts?.limit ?? 50

  const redisContent = (() => {
    if (normalizedType === 'redis_string') {
      return (
        <StringEditor
          value={stringValue}
          isJson={isJson}
          saving={saving}
          readOnly={valueEditingDisabled}
          onSave={(value) => runMutation({ type: 'update', data: { value } })}
          onSelectionContextMenu={handleStringContextMenu}
        />
      )
    }

    if (normalizedType === 'redis_hash') {
      return (
        <HashEditor
          rows={rows}
          saving={saving}
          readOnly={valueEditingDisabled}
          onUpdate={(field, value) => runMutation({ type: 'update', where: { field }, data: { value } })}
          onDelete={(field) => runMutation({ type: 'delete', where: { field } })}
          onInsert={(field, value) => runMutation({ type: 'insert', data: { field, value } })}
          onElementContextMenu={handleElementContextMenu}
          readOnlyNote={
            hasBinary && !readOnly
              ? 'Value is not valid UTF-8. Shown as \\xNN escapes; editing is disabled so the original bytes survive.'
              : undefined
          }
        />
      )
    }

    if (normalizedType === 'redis_list') {
      return (
        <ListEditor
          rows={rows}
          saving={saving}
          readOnly={valueEditingDisabled}
          offset={listOffset}
          limit={listLimit}
          total={total}
          onUpdate={(index, value) => runMutation({ type: 'update', where: { index }, data: { value } })}
          onDelete={(index) => runMutation({ type: 'delete', where: { index } })}
          onInsert={(value, direction) => runMutation({ type: 'insert', data: { value, direction } })}
          onNext={() => {
            const nextOpts = { offset: listOffset + listLimit }
            setOpts(tabId, nextOpts)
            void fetchData(connId, object, tabId, nextOpts)
          }}
          onPrev={() => {
            const nextOpts = { offset: Math.max(0, listOffset - listLimit) }
            setOpts(tabId, nextOpts)
            void fetchData(connId, object, tabId, nextOpts)
          }}
          onElementContextMenu={handleElementContextMenu}
        />
      )
    }

    if (normalizedType === 'redis_set') {
      return (
        <SetEditor
          rows={rows}
          saving={saving}
          readOnly={valueEditingDisabled}
          onInsert={(member) => runMutation({ type: 'insert', data: { member } })}
          onDelete={(member) => runMutation({ type: 'delete', where: { member } })}
          onElementContextMenu={handleElementContextMenu}
        />
      )
    }

    if (normalizedType === 'redis_zset') {
      return (
        <SortedSetEditor
          rows={rows}
          saving={saving}
          readOnly={valueEditingDisabled}
          onUpdateScore={(member, score) => runMutation({ type: 'update', where: { member }, data: { score } })}
          onDelete={(member) => runMutation({ type: 'delete', where: { member } })}
          onInsert={(member, score) => runMutation({ type: 'insert', data: { member, score } })}
          onElementContextMenu={handleElementContextMenu}
        />
      )
    }

    if (normalizedType === 'redis_stream') {
      return (
        <StreamViewer
          columns={columns}
          rows={rows}
          meta={meta}
          loading={loading}
          onLoadOlder={() => {
            const firstId = typeof meta.first_id === 'string' ? meta.first_id : ''
            setOpts(tabId, {
              offset: 0,
              filters: firstId ? [{ column: 'before_id', op: 'eq', value: firstId }] : [],
            })
            void fetchData(connId, object, tabId, {
              offset: 0,
              filters: firstId ? [{ column: 'before_id', op: 'eq', value: firstId }] : [],
            })
          }}
          onLoadNewer={() => {
            const lastId = typeof meta.last_id === 'string' ? meta.last_id : ''
            setOpts(tabId, {
              offset: 0,
              filters: lastId ? [{ column: 'after_id', op: 'eq', value: lastId }] : [],
            })
            void fetchData(connId, object, tabId, {
              offset: 0,
              filters: lastId ? [{ column: 'after_id', op: 'eq', value: lastId }] : [],
            })
          }}
        />
      )
    }

    if (normalizedType === 'redis_json') {
      return (
        <JsonEditor
          rows={rows}
          saving={saving}
          onSave={(path, value) => runMutation({ type: 'update', where: { path }, data: { value } })}
        />
      )
    }

    return (
      <EmptyState
        variant="no_tables"
        title="Unsupported Redis key"
        description="This key type is not wired into the current editor set yet."
      />
    )
  })()

  if (loading && rows.length === 0 && columns.length === 0) {
    return (
      <div className="flex flex-1 overflow-auto p-6">
        <div className="w-full space-y-4">
          <LoadingSkeleton variant="table" />
        </div>
      </div>
    )
  }

  if (error && rows.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center p-6">
        <div className="w-full max-w-2xl space-y-4">
          <ErrorBanner message={error} onRetry={() => void refresh()} />
          <EmptyState
            variant="no_tables"
            title="Redis key unavailable"
            description="The selected key could not be loaded. Refresh the tree or verify the key still exists."
          />
        </div>
      </div>
    )
  }

  return (
    <>
      <div className="flex flex-1 overflow-auto p-6">
        <div className="mx-auto flex w-full max-w-6xl flex-col gap-4">
          <div className="rounded-sm border border-border bg-card">
            <div className="flex flex-wrap items-start justify-between gap-4 border-b border-border px-4 py-4">
              <div className="flex min-w-0 items-start gap-3">
                <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-sm border border-red-500/20 bg-red-500/5">
                  <KeyRound className="h-4.5 w-4.5 text-red-500" />
                </div>
                <div className="min-w-0">
                  <div className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground">Redis key</div>
                  {/* Renaming edits this name, so the pencil sits on it rather
                      than in the row of actions on the far side of the header. */}
                  <div className="mt-1 flex min-w-0 items-center gap-1.5">
                    <h2 className="truncate font-mono text-lg font-semibold text-foreground">{object}</h2>
                    {!readOnly && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="h-7 w-7 shrink-0 p-0 text-muted-foreground hover:text-foreground"
                        onClick={() => setRenameOpen(true)}
                        disabled={saving || renaming}
                        title="Rename"
                        aria-label="Rename key"
                      >
                        <PenLine className="h-3.5 w-3.5" />
                      </Button>
                    )}
                  </div>
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <span className={cn('inline-flex items-center rounded-sm border px-2 py-1 text-[10px] uppercase tracking-[0.14em]', getRedisTypePillClass(metaType ?? objectType))}>
                      {getRedisObjectTypeLabel(metaType ?? objectType)}
                    </span>
                    {/* Beside TTL rather than in a panel of its own: how much a
                        key weighs belongs with the other small facts about it,
                        not alongside which connection it came from. */}
                    {memoryBytes !== null && (
                      <span
                        className="inline-flex items-center rounded-sm border border-sky-500/30 bg-sky-500/5 px-2 py-1 font-mono text-[10px] uppercase tracking-[0.14em] text-sky-600 dark:text-sky-400"
                        title="Memory this key occupies, sampled by Redis on large collections"
                      >
                        <Binary className="mr-1 h-3 w-3" />
                        {formatBytes(memoryBytes)}
                      </span>
                    )}
                    {ttlLabel && readOnly && (
                      <span className={cn('inline-flex items-center rounded-sm border px-2 py-1 text-[10px] font-mono uppercase tracking-[0.14em]', getRedisTTLStyle(currentTTL))}>
                        <TimerReset className="mr-1 h-3 w-3" />
                        {ttlLabel}
                      </span>
                    )}
                    {ttlLabel && !readOnly && (
                      <button
                        type="button"
                        className={cn('inline-flex items-center rounded-sm border px-2 py-1 text-[10px] font-mono uppercase tracking-[0.14em]', getRedisTTLStyle(currentTTL))}
                        onClick={() => setTTLDialogOpen(true)}
                      >
                        <TimerReset className="mr-1 h-3 w-3" />
                        {ttlLabel}
                      </button>
                    )}
                    {hasBinary && (
                      <span
                        className="inline-flex items-center rounded-sm border border-sky-500/30 bg-sky-500/5 px-2 py-1 font-mono text-[10px] uppercase tracking-[0.14em] text-sky-600 dark:text-sky-400"
                        title="Value is not valid UTF-8. Shown as \xNN escapes; editing is disabled so the original bytes are not destroyed."
                      >
                        <Binary className="mr-1 h-3 w-3" />
                        Binary
                      </span>
                    )}
                  </div>
                </div>
              </div>

              <div className="flex items-center gap-2">
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button type="button" variant="outline" size="sm" className="h-8 gap-1.5">
                      <Link2 className="h-3.5 w-3.5" />
                      Links
                    </Button>
                  </DropdownMenuTrigger>
                  {/* max-w — та же защита, что и у FloatingMenu: длина значения
                      линка не должна определять ширину меню. */}
                  <DropdownMenuContent align="end" className="max-w-[36rem]">
                    {keyLinks.slice(0, LINK_MENU_CAP).map((link) => {
                      const value = extractRedisValue(link, object, stringValue, rows)
                      return (
                        <DropdownMenuItem
                          key={link.id}
                          disabled={value === null}
                          onClick={() => {
                            if (value !== null) openLinkTarget(link, value)
                          }}
                          className="font-mono text-xs"
                        >
                          <span className="block min-w-0 max-w-[32rem] truncate">
                            {value === null ? `${linkTargetLabel(link, null)} (no value)` : linkTargetLabel(link, value)}
                          </span>
                        </DropdownMenuItem>
                      )
                    })}
                    {keyLinks.length > LINK_MENU_CAP && (
                      <DropdownMenuItem className="font-mono text-xs" onClick={() => setPickerGroup('key')}>
                        {`Show all (${keyLinks.length})…`}
                      </DropdownMenuItem>
                    )}
                    {reverseLinks.length > 0 && <DropdownMenuSeparator />}
                    {reverseLinks.length > 0 && (
                      <div className="px-2 py-1 text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
                        Back to source
                      </div>
                    )}
                    {reverseLinks.slice(0, LINK_MENU_CAP).map((link) => {
                      const value = captureFromKey(link.key_pattern ?? '', object)
                      return (
                        <DropdownMenuItem
                          key={`rev-${link.id}`}
                          disabled={value === null}
                          onClick={() => {
                            if (value !== null) openLinkSource(link, value)
                          }}
                          className="font-mono text-xs"
                        >
                          <span className="block min-w-0 max-w-[32rem] truncate">
                            {value === null ? `${linkSourceLabel(link, null)} (no value)` : linkSourceLabel(link, value)}
                          </span>
                        </DropdownMenuItem>
                      )
                    })}
                    {reverseLinks.length > LINK_MENU_CAP && (
                      <DropdownMenuItem className="font-mono text-xs" onClick={() => setPickerGroup('reverse')}>
                        {`Show all (${reverseLinks.length})…`}
                      </DropdownMenuItem>
                    )}
                    {/* Per-element линки некликабельны в шапке: у них нет значения
                        на уровне ключа. Показываем справочно, чтобы линк не
                        выглядел пропавшим — переход делается правым кликом. */}
                    {perElementLinks.length > 0 && <DropdownMenuSeparator />}
                    {perElementLinks.length > 0 && (
                      <div className="px-2 py-1 text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
                        Per-element · right-click a value
                      </div>
                    )}
                    {perElementLinks.slice(0, LINK_MENU_CAP).map((link) => (
                      <DropdownMenuItem key={`pe-${link.id}`} disabled className="font-mono text-xs">
                        <span className="block min-w-0 max-w-[32rem] truncate">{linkSummary(link)}</span>
                      </DropdownMenuItem>
                    ))}
                    {perElementLinks.length > LINK_MENU_CAP && (
                      <DropdownMenuItem className="font-mono text-xs" onClick={() => setPickerGroup('perElement')}>
                        {`Show all (${perElementLinks.length})…`}
                      </DropdownMenuItem>
                    )}
                    {/* Point at this key but cannot be walked back to their
                        source, so they are shown, not followed. */}
                    {inboundOnlyLinks.length > 0 && <DropdownMenuSeparator />}
                    {inboundOnlyLinks.length > 0 && (
                      <div className="px-2 py-1 text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
                        Points here · not reversible
                      </div>
                    )}
                    {inboundOnlyLinks.slice(0, LINK_MENU_CAP).map((link) => (
                      <DropdownMenuItem key={`in-${link.id}`} disabled className="font-mono text-xs">
                        <span className="block min-w-0 max-w-[32rem] truncate">
                          {linkSummary(link, connectionName)}
                        </span>
                      </DropdownMenuItem>
                    ))}
                    {/* What else the connection is wired to is not asked about
                        here — this menu is about this key. The whole list lives
                        beside Overview, where the connection's other facts are. */}
                    {(keyLinks.length > 0 ||
                      reverseLinks.length > 0 ||
                      perElementLinks.length > 0 ||
                      inboundOnlyLinks.length > 0) && <DropdownMenuSeparator />}
                    <DropdownMenuItem className="font-mono text-xs" onClick={() => setCreateLinkOpen(true)}>
                      + Create link…
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
                {/* Icons only past this point: the header already carries the
                    key, its type, its size and its TTL, and five labelled
                    buttons beside all of that read as noise. Links keeps its
                    word — it opens a menu rather than doing something. */}
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-8 w-8 p-0"
                  onClick={() => void refresh()}
                  disabled={loading || saving}
                  title="Refresh"
                  aria-label="Refresh key"
                >
                  <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />
                </Button>
                {readOnly ? (
                  <span className="inline-flex items-center gap-1.5 rounded-sm border border-amber-500/30 bg-amber-500/5 px-2 py-1 font-mono text-[10px] uppercase tracking-[0.12em] text-amber-600 dark:text-amber-400">
                    <Lock className="h-3 w-3" />
                    Read-only
                  </span>
                ) : (
                  <>
                    {/* Duplicating beats recreating by hand: the contents are
                        already right, only the name is new. */}
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="h-8 w-8 p-0"
                      onClick={() => {
                        setCopyName(`${object}-copy`)
                        setCopyOpen(true)
                      }}
                      disabled={saving}
                      title="Duplicate"
                      aria-label="Duplicate key"
                    >
                      <CopyIcon className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      type="button"
                      variant="destructive"
                      size="sm"
                      className="h-8 w-8 p-0"
                      onClick={() => setDeleteDialogOpen(true)}
                      disabled={saving}
                      title="Delete key"
                      aria-label="Delete key"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </>
                )}
              </div>
            </div>

          </div>

          {Boolean(meta.truncated) && (
            <div className="rounded-sm border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-amber-600 dark:text-amber-400">
              Partial view — this key is too large to load fully, so only the first scanned slice is shown
              {typeof meta.length === 'number' ? ` (${meta.length.toLocaleString()} items total)` : ''}. Use the
              filter to narrow it down.
            </div>
          )}
          {!loading && total === 0 && rows.length === 0 ? (
            <EmptyState
              variant="no_tables"
              title="Key has no visible items"
              description="The key exists, but the current slice returned no rows for this editor."
            />
          ) : (
            redisContent
          )}
        </div>
      </div>

      <SetTTLDialog
        open={ttlDialogOpen}
        keyName={object}
        currentTTL={currentTTL}
        saving={saving}
        onOpenChange={setTTLDialogOpen}
        onConfirm={async (nextTTL) => {
          await runMutation({ type: 'update', data: { ttl: nextTTL } })
          setTTLDialogOpen(false)
        }}
      />

      <Dialog open={copyOpen} onOpenChange={setCopyOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="font-mono text-sm">Duplicate key</DialogTitle>
            <DialogDescription className="font-mono text-xs">
              Copies the contents and TTL of {object} to a new key.
            </DialogDescription>
          </DialogHeader>
          <Input
            value={copyName}
            onChange={(event) => setCopyName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                void duplicateKey()
              }
            }}
            placeholder="new key name"
            className="font-mono"
            aria-label="New key name"
            autoFocus
          />
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={() => setCopyOpen(false)}>
              Cancel
            </Button>
            <Button type="button" size="sm" disabled={copying || copyName.trim() === ''} onClick={() => void duplicateKey()}>
              {copying ? 'Duplicating…' : 'Duplicate'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <RenameKeyDialog
        open={renameOpen}
        keyName={object}
        saving={renaming}
        onOpenChange={setRenameOpen}
        onConfirm={renameKey}
      />

      <DeleteKeyDialog
        open={deleteDialogOpen}
        keyName={object}
        deleting={saving}
        onOpenChange={setDeleteDialogOpen}
        onConfirm={async () => {
          await runMutation({ type: 'delete' })
          await refreshTree(connId)
          closeTab(tabId)
        }}
      />

      <CreateLinkDialog
        open={createLinkOpen}
        sourceConnId={connId}
        sourceKind="redis"
        sourceScope={suggestKeyPattern(object)}
        sourceFieldOptions={hashFieldNames}
        initialExtract={createFromElement ? 'selection' : undefined}
        initialSourceField={createFromElement?.field}
        onOpenChange={(next) => {
          setCreateLinkOpen(next)
          if (!next) {
            setCreateFromElement(null)
          }
        }}
      />

      {memberMenu && (
        <FloatingMenu x={memberMenu.x} y={memberMenu.y} onClose={() => setMemberMenu(null)}>
          {memberLinks.length > 0 && <FloatingMenuLabel>Open from element</FloatingMenuLabel>}
          {memberLinks.slice(0, LINK_MENU_CAP).map((link) => (
            <FloatingMenuItem
              key={link.id}
              onClick={() => {
                openLinkTarget(link, memberMenu.member)
                setMemberMenu(null)
              }}
            >
              {linkTargetLabel(link, memberMenu.member)}
            </FloatingMenuItem>
          ))}
          {memberLinks.length > LINK_MENU_CAP && (
            <FloatingMenuItem onClick={() => setPickerGroup('member')}>
              {`Show all (${memberLinks.length})…`}
            </FloatingMenuItem>
          )}

          {elementSelectionLinks.length > 0 && memberLinks.length > 0 && <FloatingMenuSeparator />}
          {elementSelectionLinks.length > 0 && (
            <FloatingMenuLabel>
              {memberMenu.token === null ? 'No value under cursor' : `Open from "${memberMenu.token}"`}
            </FloatingMenuLabel>
          )}
          {elementSelectionLinks.slice(0, LINK_MENU_CAP).map((link) => (
            <FloatingMenuItem
              key={`sel-${link.id}`}
              disabled={memberMenu.token === null}
              onClick={() => {
                if (memberMenu.token !== null) {
                  openLinkTarget(link, memberMenu.token)
                  setMemberMenu(null)
                }
              }}
            >
              {linkTargetLabel(link, memberMenu.token)}
            </FloatingMenuItem>
          ))}
          {elementSelectionLinks.length > LINK_MENU_CAP && (
            <FloatingMenuItem onClick={() => setPickerGroup('selection')}>
              {`Show all (${elementSelectionLinks.length})…`}
            </FloatingMenuItem>
          )}

          {(memberLinks.length > 0 || elementSelectionLinks.length > 0) && <FloatingMenuSeparator />}
          <FloatingMenuItem
            onClick={() => {
              setCreateFromElement({ field: memberMenu.field })
              setMemberMenu(null)
              setCreateLinkOpen(true)
            }}
          >
            + Create link from here…
          </FloatingMenuItem>
        </FloatingMenu>
      )}

      <LinkPickerDialog
        open={pickerGroup !== null}
        onOpenChange={(next) => {
          if (!next) setPickerGroup(null)
        }}
        title={
          pickerGroup === 'reverse'
            ? 'Back to source'
            : pickerGroup === 'perElement'
            ? 'Per-element links (right-click a value)'
            : pickerGroup === 'selection'
            ? `Open from "${memberMenu?.token ?? ''}"`
            : pickerGroup === 'member'
            ? 'Open from element'
            : 'Links'
        }
        items={pickerItems}
      />
    </>
  )
}
