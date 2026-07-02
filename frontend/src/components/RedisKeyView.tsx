import { useEffect, useMemo, useState, type MouseEvent } from 'react'
import { KeyRound, Link2, Lock, RefreshCw, TimerReset, Trash2 } from 'lucide-react'
import { EmptyState } from '@/components/EmptyState'
import { ErrorBanner } from '@/components/ErrorBanner'
import { LoadingSkeleton } from '@/components/LoadingSkeleton'
import { DeleteKeyDialog } from '@/components/redis/DeleteKeyDialog'
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
import { FloatingMenu, FloatingMenuItem, FloatingMenuLabel } from '@/components/ui/floating-menu'
import { useOpenLinkTarget } from '@/hooks/useOpenLinkTarget'
import { useOpenLinkSource } from '@/hooks/useOpenLinkSource'
import {
  canReverse,
  captureFromKey,
  extractRedisValue,
  linkSourceLabel,
  linkTargetLabel,
  redisKeyMatchesPattern,
  suggestKeyPattern,
} from '@/lib/links'
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

function metaCard(label: string, value: string, accentClass: string) {
  return (
    <div className="rounded-sm border border-border bg-muted/10 px-3 py-3">
      <div className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground">{label}</div>
      <div className={cn('mt-2 font-mono text-sm', accentClass)}>{value}</div>
    </div>
  )
}

export function RedisKeyView({ connId, tabId, object, objectType, ttlSeconds }: RedisKeyViewProps) {
  const connection = useConnectionStore((state) => state.connections.find((item) => item.id === connId))
  const tabData = useDataStore((state) => state.tabs[tabId])
  const fetchData = useDataStore((state) => state.fetchData)
  const mutate = useDataStore((state) => state.mutate)
  const setOpts = useDataStore((state) => state.setOpts)
  const refreshTree = useWorkspaceStore((state) => state.refreshTree)
  const closeTab = useWorkspaceStore((state) => state.closeTab)
  const pushToast = useToastStore((state) => state.push)

  const [saving, setSaving] = useState(false)
  const [ttlDialogOpen, setTTLDialogOpen] = useState(false)
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false)

  const links = useLinksStore((state) => state.links)
  const fetchLinks = useLinksStore((state) => state.fetch)
  const openLinkTarget = useOpenLinkTarget()
  const [createLinkOpen, setCreateLinkOpen] = useState(false)

  useEffect(() => {
    void fetchData(connId, object, tabId)
  }, [connId, fetchData, object, tabId])

  useEffect(() => {
    void fetchLinks().catch(() => undefined)
  }, [fetchLinks])

  const keyLinks = useMemo(
    () =>
      links.filter(
        (link) =>
          link.source_conn_id === connId &&
          link.source_kind === 'redis' &&
          // member links are per-element (right-click a row), not key-level —
          // they have no single key value, so keep them out of the header menu.
          link.source_extract !== 'member' &&
          redisKeyMatchesPattern(link.source_scope, object)
      ),
    [links, connId, object]
  )

  const memberLinks = useMemo(
    () =>
      links.filter(
        (link) =>
          link.source_conn_id === connId &&
          link.source_kind === 'redis' &&
          link.source_extract === 'member' &&
          redisKeyMatchesPattern(link.source_scope, object)
      ),
    [links, connId, object]
  )
  const [memberMenu, setMemberMenu] = useState<{ x: number; y: number; value: string } | null>(null)
  const handleElementContextMenu = (value: string, event: MouseEvent) => {
    event.preventDefault()
    setMemberMenu({ x: event.clientX, y: event.clientY, value })
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

  const rows = useMemo(() => tabData?.rows ?? [], [tabData?.rows])
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
  const normalizedType = normalizeRedisObjectType(metaType ?? objectType)
  const currentTTL = typeof meta.ttl === 'number' ? meta.ttl : (ttlSeconds ?? null)
  const ttlLabel = formatRedisTTL(currentTTL)
  const isJson = Boolean(meta.is_json)
  const readOnly = connection?.read_only ?? false

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
  const stringValue = useMemo(() => stringifyRedisValue(rows[0]?.value), [rows])

  const redisContent = (() => {
    if (normalizedType === 'redis_string') {
      return <StringEditor value={stringValue} isJson={isJson} saving={saving} readOnly={readOnly} onSave={(value) => runMutation({ type: 'update', data: { value } })} />
    }

    if (normalizedType === 'redis_hash') {
      return (
        <HashEditor
          rows={rows}
          saving={saving}
          readOnly={readOnly}
          onUpdate={(field, value) => runMutation({ type: 'update', where: { field }, data: { value } })}
          onDelete={(field) => runMutation({ type: 'delete', where: { field } })}
          onInsert={(field, value) => runMutation({ type: 'insert', data: { field, value } })}
          onElementContextMenu={memberLinks.length > 0 ? handleElementContextMenu : undefined}
        />
      )
    }

    if (normalizedType === 'redis_list') {
      return (
        <ListEditor
          rows={rows}
          saving={saving}
          readOnly={readOnly}
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
          onElementContextMenu={memberLinks.length > 0 ? handleElementContextMenu : undefined}
        />
      )
    }

    if (normalizedType === 'redis_set') {
      return (
        <SetEditor
          rows={rows}
          saving={saving}
          readOnly={readOnly}
          onInsert={(member) => runMutation({ type: 'insert', data: { member } })}
          onDelete={(member) => runMutation({ type: 'delete', where: { member } })}
          onElementContextMenu={memberLinks.length > 0 ? handleElementContextMenu : undefined}
        />
      )
    }

    if (normalizedType === 'redis_zset') {
      return (
        <SortedSetEditor
          rows={rows}
          saving={saving}
          readOnly={readOnly}
          onUpdateScore={(member, score) => runMutation({ type: 'update', where: { member }, data: { score } })}
          onDelete={(member) => runMutation({ type: 'delete', where: { member } })}
          onInsert={(member, score) => runMutation({ type: 'insert', data: { member, score } })}
          onElementContextMenu={memberLinks.length > 0 ? handleElementContextMenu : undefined}
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
                  <h2 className="mt-1 truncate font-mono text-lg font-semibold text-foreground">{object}</h2>
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <span className={cn('inline-flex items-center rounded-sm border px-2 py-1 text-[10px] uppercase tracking-[0.14em]', getRedisTypePillClass(metaType ?? objectType))}>
                      {getRedisObjectTypeLabel(metaType ?? objectType)}
                    </span>
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
                  <DropdownMenuContent align="end">
                    {keyLinks.map((link) => {
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
                          {value === null ? `${linkTargetLabel(link, null)} (no value)` : linkTargetLabel(link, value)}
                        </DropdownMenuItem>
                      )
                    })}
                    {reverseLinks.length > 0 && <DropdownMenuSeparator />}
                    {reverseLinks.length > 0 && (
                      <div className="px-2 py-1 text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
                        Back to source
                      </div>
                    )}
                    {reverseLinks.map((link) => {
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
                          {value === null ? `${linkSourceLabel(link, null)} (no value)` : linkSourceLabel(link, value)}
                        </DropdownMenuItem>
                      )
                    })}
                    {keyLinks.length > 0 && <DropdownMenuSeparator />}
                    <DropdownMenuItem className="font-mono text-xs" onClick={() => setCreateLinkOpen(true)}>
                      + Create link…
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
                <Button type="button" variant="outline" size="sm" className="h-8 gap-1.5" onClick={() => void refresh()} disabled={loading || saving}>
                  <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />
                  Refresh
                </Button>
                {readOnly ? (
                  <span className="inline-flex items-center gap-1.5 rounded-sm border border-amber-500/30 bg-amber-500/5 px-2 py-1 font-mono text-[10px] uppercase tracking-[0.12em] text-amber-600 dark:text-amber-400">
                    <Lock className="h-3 w-3" />
                    Read-only
                  </span>
                ) : (
                  <Button type="button" variant="destructive" size="sm" className="h-8 gap-1.5" onClick={() => setDeleteDialogOpen(true)} disabled={saving}>
                    <Trash2 className="h-3.5 w-3.5" />
                    Delete key
                  </Button>
                )}
              </div>
            </div>

            <div className="grid gap-3 border-b border-border px-4 py-4 sm:grid-cols-3">
              {metaCard('Type', getRedisObjectTypeLabel(metaType ?? objectType), 'text-foreground')}
              {metaCard('Connection', connection?.name ?? connId, 'text-foreground')}
              {metaCard('Mode', connection?.mode ?? 'standalone', 'text-foreground')}
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
        onOpenChange={setCreateLinkOpen}
      />

      {memberMenu && (
        <FloatingMenu x={memberMenu.x} y={memberMenu.y} onClose={() => setMemberMenu(null)}>
          <FloatingMenuLabel>Open from element</FloatingMenuLabel>
          {memberLinks.map((link) => (
            <FloatingMenuItem
              key={link.id}
              onClick={() => {
                openLinkTarget(link, memberMenu.value)
                setMemberMenu(null)
              }}
            >
              {linkTargetLabel(link, memberMenu.value)}
            </FloatingMenuItem>
          ))}
        </FloatingMenu>
      )}
    </>
  )
}
