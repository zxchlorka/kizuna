import { useState } from 'react'
import { Activity, Lock, Pencil, RefreshCw, Trash2 } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { ConnectionTypeIcon } from '@/components/ConnectionTypeIcon'
import { DeleteConnectionDialog } from '@/components/DeleteConnectionDialog'
import { getConnectionTagClass } from '@/lib/connectionTags'
import { cn } from '@/lib/utils'
import { isConnectionHealthStale, useConnectionHealthStore } from '@/stores/connectionHealth'
import { useToastStore } from '@/stores/toast'
import type { Connection } from '@/types/api'

interface ConnectionCardProps {
  connection: Connection
  onDelete: (id: string) => Promise<void>
  onEdit: (connection: Connection) => void
}

export function ConnectionCard({ connection, onDelete, onEdit }: ConnectionCardProps) {
  const navigate = useNavigate()
  const pushToast = useToastStore((state) => state.push)
  const healthEntry = useConnectionHealthStore((state) => state.entries[connection.id])
  const refreshHealth = useConnectionHealthStore((state) => state.refresh)
  const [retesting, setRetesting] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false)

  const handleOpen = async () => {
    if (deleting || retesting) {
      return
    }

    navigate(`/connections/${connection.id}`)
    if (isConnectionHealthStale(healthEntry)) {
      void refreshHealth(connection.id).catch(() => {
        // The page navigation should not be blocked by background health refresh failures.
      })
    }
  }

  const handleDeleteClick = (e: React.MouseEvent) => {
    e.stopPropagation()
    if (deleting) {
      return
    }
    setDeleteDialogOpen(true)
  }

  const handleDeleteConfirm = async () => {
    setDeleting(true)
    try {
      await onDelete(connection.id)
      setDeleteDialogOpen(false)
    } catch (error) {
      pushToast({
        tone: 'error',
        title: 'Delete failed',
        message: (error as Error).message,
      })
    } finally {
      setDeleting(false)
    }
  }

  const handleEdit = (e: React.MouseEvent) => {
    e.stopPropagation()
    if (deleting) {
      return
    }
    onEdit(connection)
  }

  const handleRetest = (e: React.MouseEvent) => {
    e.stopPropagation()
    if (retesting || deleting) {
      return
    }

    setRetesting(true)
    void refreshHealth(connection.id, { force: true })
      .catch((error) => {
        pushToast({
          tone: 'error',
          title: 'Connection test failed',
          message: (error as Error).message,
        })
      })
      .finally(() => {
        setRetesting(false)
      })
  }

  const healthStatus = healthEntry?.status ?? 'unknown'
  const checking = healthEntry?.checking ?? false
  const latencyLabel = healthEntry?.latencyMs ? `${healthEntry.latencyMs}ms` : null
  const statusLabel = (() => {
    if (checking && healthStatus === 'healthy' && latencyLabel) {
      return `refreshing ${latencyLabel}`
    }
    if (checking && healthStatus === 'unhealthy') {
      return 'retrying...'
    }
    if (checking) {
      return 'checking...'
    }
    if (healthStatus === 'healthy') {
      return latencyLabel ? `ok ${latencyLabel}` : 'online'
    }
    if (healthStatus === 'unhealthy') {
      return 'offline'
    }
    return 'unknown'
  })()

  const tags = connection.tags ?? []
  const pathValue = connection.database ?? 0
  const detailLabel = connection.type === 'redis' ? connection.username || '' : connection.username || 'user'

  return (
    <>
      <div
        onClick={() => void handleOpen()}
        className={cn(
          'group relative cursor-pointer select-none overflow-visible border border-border bg-card',
          'transition-all duration-200',
          'hover:-translate-y-0.5 hover:border-amber-500/25',
          'hover:shadow-[0_4px_24px_-8px_rgba(245,158,11,0.15)]'
        )}
      >
        <div className="pointer-events-none absolute inset-0 opacity-0 transition-opacity duration-150 group-hover:opacity-100">
          <div className="absolute -left-px -top-px h-2 w-2 bg-amber-500" />
          <div className="absolute -right-px -top-px h-2 w-2 bg-amber-500" />
          <div className="absolute -left-px -bottom-px h-2 w-2 bg-amber-500" />
          <div className="absolute -right-px -bottom-px h-2 w-2 bg-amber-500" />
        </div>

        <div
          className={cn(
            'absolute bottom-0 left-0 top-0 w-[2px] transition-colors duration-200',
            connection.type === 'redis'
              ? 'bg-red-500/20 group-hover:bg-red-500/45'
              : connection.type === 'kafka'
                ? 'bg-orange-500/20 group-hover:bg-orange-500/45'
                : 'bg-blue-500/20 group-hover:bg-blue-500/50'
          )}
        />

        <div className="flex min-h-[164px] flex-col justify-between px-4 pb-3 pl-5 pt-4">
          <div className="flex items-start gap-3">
            <div
              className={cn(
                'mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-sm border transition-colors duration-200',
                connection.type === 'redis'
                  ? 'border-red-500/15 bg-red-500/5 group-hover:border-red-500/30'
                  : connection.type === 'kafka'
                    ? 'border-orange-500/15 bg-orange-500/5 group-hover:border-orange-500/30'
                    : 'border-blue-500/15 bg-blue-500/5 group-hover:border-blue-500/30'
              )}
            >
              <ConnectionTypeIcon type={connection.type || 'postgres'} className="h-4 w-4" />
            </div>

            <div className="min-w-0 flex-1">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <p className="truncate font-mono text-sm font-semibold leading-tight text-foreground">{connection.name}</p>
                  <p className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground">
                    {connection.host}:{connection.port}/<span className="text-muted-foreground/80">{String(pathValue)}</span>
                  </p>
                  <div className="mt-1 min-h-[0.875rem]">
                    {detailLabel ? (
                      <p className="truncate font-mono text-[10px] text-muted-foreground/50">{detailLabel}</p>
                    ) : null}
                  </div>
                </div>

                <div className="mt-0.5 flex shrink-0 items-center gap-1.5">
                  <div className="relative flex h-4 w-4 items-center justify-center">
                    <span
                      className={cn(
                        'relative z-10 block h-2.5 w-2.5 rounded-full',
                        healthStatus === 'healthy' && 'bg-green-500',
                        healthStatus === 'unhealthy' && 'bg-red-500',
                        healthStatus === 'unknown' && 'bg-muted-foreground/30',
                        checking && 'animate-pulse'
                      )}
                    />
                    {healthStatus === 'healthy' && !checking && (
                      <span className="absolute h-2.5 w-2.5 animate-glow-ping rounded-full bg-green-500" />
                    )}
                  </div>

                  <button
                    onClick={handleEdit}
                    disabled={deleting}
                    className="rounded-sm p-1 text-muted-foreground/60 opacity-0 transition-all duration-150 group-hover:opacity-100 hover:bg-amber-500/10 hover:text-amber-500 disabled:pointer-events-none disabled:opacity-40"
                    title="Edit connection"
                  >
                    <Pencil className="h-3.5 w-3.5" />
                  </button>

                  <button
                    onClick={handleDeleteClick}
                    disabled={deleting}
                    className={cn(
                      'rounded-sm p-1 text-red-500/70 opacity-0 transition-all duration-150 group-hover:opacity-100',
                      'hover:bg-red-500/10 hover:text-red-400 disabled:pointer-events-none disabled:opacity-50'
                    )}
                    title={deleting ? 'Deleting...' : 'Delete'}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>

              <div className="mt-3 flex min-h-[2rem] flex-wrap content-start gap-1.5">
                {tags.map((tag) => (
                  <span
                    key={tag}
                    className={cn(
                      'rounded-sm border px-2 py-1 font-mono text-[10px] font-semibold uppercase tracking-[0.14em]',
                      getConnectionTagClass(tag)
                    )}
                  >
                    {tag}
                  </span>
                ))}
              </div>
            </div>
          </div>

          <div className="mt-4 flex items-center justify-between gap-3">
            <div className="flex items-center gap-1.5">
              <span
                className={cn(
                  'rounded-sm border px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-[0.12em]',
                  connection.type === 'redis'
                    ? 'border-red-500/20 bg-red-500/5 text-red-400/70'
                    : connection.type === 'kafka'
                      ? 'border-orange-500/20 bg-orange-500/5 text-orange-400/70'
                      : 'border-blue-500/15 bg-blue-500/5 text-blue-400/60'
                )}
              >
                {connection.type || 'postgres'}
              </span>
              {connection.read_only && (
                <span className="inline-flex items-center gap-1 rounded-sm border border-amber-500/30 bg-amber-500/5 px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-[0.12em] text-amber-500/80">
                  <Lock className="h-2.5 w-2.5" />
                  RO
                </span>
              )}
            </div>

            <div className="ml-auto flex items-center gap-2 text-right">
              <span
                className={cn(
                  'font-mono text-[10px] uppercase tracking-[0.12em]',
                  healthStatus === 'healthy' && 'text-green-500',
                  healthStatus === 'unhealthy' && 'text-red-500',
                  healthStatus === 'unknown' && 'text-muted-foreground/50'
                )}
              >
                {statusLabel}
              </span>
              <button
                onClick={handleRetest}
                className={cn(
                  'flex shrink-0 items-center gap-1 font-mono text-[10px] text-muted-foreground/40 transition-colors hover:text-muted-foreground',
                  (retesting || deleting) && 'pointer-events-none'
                )}
                title="Re-test connection"
              >
                {checking || retesting ? (
                  <Activity className="h-2.5 w-2.5 animate-pulse" />
                ) : (
                  <RefreshCw className="h-2.5 w-2.5" />
                )}
                {retesting ? 'testing...' : 'test'}
              </button>
            </div>
          </div>
        </div>
      </div>

      <DeleteConnectionDialog
        open={deleteDialogOpen}
        connectionName={connection.name}
        deleting={deleting}
        onOpenChange={setDeleteDialogOpen}
        onConfirm={handleDeleteConfirm}
      />
    </>
  )
}
