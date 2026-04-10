import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Pencil, RefreshCw, Trash2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useConnectionStore } from '@/stores/connections'
import { useToastStore } from '@/stores/toast'
import type { Connection } from '@/types/api'

interface ConnectionCardProps {
  connection: Connection
  onDelete: (id: string) => Promise<void>
  onEdit: (connection: Connection) => void
}

type Health = 'unknown' | 'healthy' | 'unhealthy'

export function ConnectionCard({ connection, onDelete, onEdit }: ConnectionCardProps) {
  const navigate = useNavigate()
  const test = useConnectionStore((state) => state.test)
  const pushToast = useToastStore((state) => state.push)
  const [health, setHealth] = useState<Health>('unknown')
  const [opening, setOpening] = useState(false)
  const [retesting, setRetesting] = useState(false)
  const [deleting, setDeleting] = useState(false)

  const runTest = async () => {
    setRetesting(true)
    try {
      const result = await test(connection.id)
      setHealth(result.ok ? 'healthy' : 'unhealthy')
      return result
    } catch {
      setHealth('unhealthy')
      throw new Error('Could not reach the database. Check the host, credentials, and network access.')
    } finally {
      setRetesting(false)
    }
  }

  useEffect(() => {
    let cancelled = false

    test(connection.id)
      .then((result) => {
        if (!cancelled) {
          setHealth(result.ok ? 'healthy' : 'unhealthy')
        }
      })
      .catch(() => {
        if (!cancelled) {
          setHealth('unhealthy')
        }
      })

    return () => {
      cancelled = true
    }
  }, [connection.id, test])

  const handleOpen = async () => {
    if (opening || deleting || retesting) {
      return
    }

    setOpening(true)
    try {
      await runTest()
      navigate(`/connections/${connection.id}`)
    } catch (error) {
      pushToast({
        tone: 'error',
        title: 'Connection unavailable',
        message: (error as Error).message,
      })
    } finally {
      setOpening(false)
    }
  }

  const handleDelete = async (e: React.MouseEvent) => {
    e.stopPropagation()
    if (opening || deleting) {
      return
    }

    if (!window.confirm(`Delete connection "${connection.name}"?`)) {
      return
    }

    setDeleting(true)
    try {
      await onDelete(connection.id)
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
    if (opening || deleting) {
      return
    }
    onEdit(connection)
  }

  const handleRetest = (e: React.MouseEvent) => {
    e.stopPropagation()
    if (opening || retesting || deleting) {
      return
    }

    void runTest().catch((error) => {
      pushToast({
        tone: 'error',
        title: 'Connection test failed',
        message: (error as Error).message,
      })
    })
  }

  return (
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

      <div className="absolute bottom-0 left-0 top-0 w-[2px] bg-blue-500/20 transition-colors duration-200 group-hover:bg-blue-500/50" />

      <div className="px-4 pb-3 pl-5 pt-4">
        <div className="flex items-start gap-3">
          <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-sm border border-blue-500/15 bg-blue-500/5 transition-colors duration-200 group-hover:border-blue-500/30">
            <svg viewBox="0 0 24 24" className="h-4 w-4 text-blue-400/80" fill="none" stroke="currentColor" strokeWidth="1.5">
              <ellipse cx="12" cy="5" rx="9" ry="3" />
              <path d="M3 5V19A9 3 0 0 0 21 19V5" />
              <path d="M3 12A9 3 0 0 0 21 12" />
            </svg>
          </div>

          <div className="min-w-0 flex-1">
            <p className="truncate font-mono text-sm font-semibold leading-tight text-foreground">{connection.name}</p>
            <p className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground">
              {connection.host}:{connection.port}/<span className="text-muted-foreground/80">{connection.database}</span>
            </p>
            <p className="truncate font-mono text-[10px] text-muted-foreground/50">{connection.username}</p>
            {connection.tags && connection.tags.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1">
                {connection.tags.map((tag) => (
                  <span
                    key={tag}
                    className={cn(
                      'rounded-sm border px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-[0.12em]',
                      tag === 'production'
                        ? 'border-amber-500/35 bg-amber-500/10 text-amber-500'
                        : 'border-border bg-muted/20 text-muted-foreground'
                    )}
                  >
                    {tag}
                  </span>
                ))}
              </div>
            )}
          </div>

          <div className="mt-0.5 flex shrink-0 items-center gap-1.5">
            <div className="relative flex h-4 w-4 items-center justify-center">
              <span
                className={cn(
                  'relative z-10 block h-2 w-2 rounded-full',
                  health === 'healthy' && 'bg-green-500',
                  health === 'unhealthy' && 'bg-red-500',
                  (health === 'unknown' || opening) && 'animate-pulse bg-muted-foreground/30'
                )}
              />
              {health === 'healthy' && !opening && (
                <span className="absolute h-2 w-2 animate-glow-ping rounded-full bg-green-500" />
              )}
            </div>

            <button
              onClick={handleEdit}
              disabled={opening || deleting}
              className="rounded-sm p-1 text-muted-foreground/60 opacity-0 transition-all duration-150 group-hover:opacity-100 hover:bg-amber-500/10 hover:text-amber-500 disabled:pointer-events-none disabled:opacity-40"
              title="Edit connection"
            >
              <Pencil className="h-3 w-3" />
            </button>

            <button
              onClick={handleDelete}
              disabled={deleting || opening}
              className={cn(
                'rounded-sm p-1 opacity-0 transition-all duration-150 group-hover:opacity-100 disabled:pointer-events-none disabled:opacity-100',
                deleting
                  ? 'bg-muted text-muted-foreground/60'
                  : 'text-muted-foreground/60 hover:bg-muted hover:text-foreground'
              )}
              title={deleting ? 'Deleting...' : 'Delete'}
            >
              <Trash2 className="h-3 w-3" />
            </button>
          </div>
        </div>

        <div className="mt-3 flex items-center justify-between">
          <span className="rounded-sm border border-blue-500/15 bg-blue-500/5 px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-[0.12em] text-blue-400/60">
            {connection.type || 'postgres'}
          </span>

          <button
            onClick={handleRetest}
            className={cn(
              'flex items-center gap-1 font-mono text-[10px] text-muted-foreground/40 transition-colors hover:text-muted-foreground',
              (retesting || opening || deleting) && 'pointer-events-none'
            )}
            title="Re-test connection"
          >
            <RefreshCw className={cn('h-2.5 w-2.5', (retesting || opening) && 'animate-spin')} />
            {deleting ? 'deleting...' : opening ? 'opening...' : retesting ? 'testing...' : 'test'}
          </button>
        </div>
      </div>
    </div>
  )
}
