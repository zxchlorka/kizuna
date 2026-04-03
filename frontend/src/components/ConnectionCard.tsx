import { useEffect, useState, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { Trash2, Pencil, RefreshCw } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useConnectionStore } from '@/stores/connections'
import type { Connection } from '@/types/api'

interface ConnectionCardProps {
  connection: Connection
  onDelete: (id: string) => void
  onEdit: (connection: Connection) => void
}

type Health = 'unknown' | 'healthy' | 'unhealthy'

export function ConnectionCard({ connection, onDelete, onEdit }: ConnectionCardProps) {
  const navigate = useNavigate()
  const test = useConnectionStore((s) => s.test)
  const [health, setHealth] = useState<Health>('unknown')
  const [retesting, setRetesting] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)

  const runTest = useCallback(async () => {
    setRetesting(true)
    try {
      const r = await test(connection.id)
      setHealth(r.ok ? 'healthy' : 'unhealthy')
    } catch {
      setHealth('unhealthy')
    } finally {
      setRetesting(false)
    }
  }, [connection.id, test])

  // Auto-test on mount
  useEffect(() => {
    let cancelled = false
    test(connection.id)
      .then((r) => { if (!cancelled) setHealth(r.ok ? 'healthy' : 'unhealthy') })
      .catch(() => { if (!cancelled) setHealth('unhealthy') })
    return () => { cancelled = true }
  }, [connection.id, test])

  const handleDelete = (e: React.MouseEvent) => {
    e.stopPropagation()
    if (confirmDelete) {
      onDelete(connection.id)
    } else {
      setConfirmDelete(true)
      setTimeout(() => setConfirmDelete(false), 3000)
    }
  }

  const handleEdit = (e: React.MouseEvent) => {
    e.stopPropagation()
    onEdit(connection)
  }

  const handleRetest = (e: React.MouseEvent) => {
    e.stopPropagation()
    if (!retesting) runTest()
  }

  return (
    <div
      onClick={() => navigate(`/connections/${connection.id}`)}
      className={cn(
        'group relative overflow-visible border border-border bg-card cursor-pointer select-none',
        'transition-all duration-200',
        'hover:border-amber-500/25 hover:-translate-y-0.5',
        'hover:shadow-[0_4px_24px_-8px_rgba(245,158,11,0.15)]'
      )}
    >
      {/* Amber corner brackets — on hover */}
      <div className="pointer-events-none absolute inset-0 opacity-0 group-hover:opacity-100 transition-opacity duration-150">
        <div className="absolute -left-px -top-px h-2 w-2 bg-amber-500" />
        <div className="absolute -right-px -top-px h-2 w-2 bg-amber-500" />
        <div className="absolute -left-px -bottom-px h-2 w-2 bg-amber-500" />
        <div className="absolute -right-px -bottom-px h-2 w-2 bg-amber-500" />
      </div>

      {/* Left accent bar */}
      <div className="absolute left-0 top-0 bottom-0 w-[2px] bg-blue-500/20 group-hover:bg-blue-500/50 transition-colors duration-200" />

      <div className="px-4 pt-4 pb-3 pl-5">
        <div className="flex items-start gap-3">
          {/* DB icon */}
          <div className="mt-0.5 h-8 w-8 shrink-0 flex items-center justify-center rounded-sm border border-blue-500/15 bg-blue-500/5 group-hover:border-blue-500/30 transition-colors duration-200">
            <svg viewBox="0 0 24 24" className="h-4 w-4 text-blue-400/80" fill="none" stroke="currentColor" strokeWidth="1.5">
              <ellipse cx="12" cy="5" rx="9" ry="3" />
              <path d="M3 5V19A9 3 0 0 0 21 19V5" />
              <path d="M3 12A9 3 0 0 0 21 12" />
            </svg>
          </div>

          {/* Info */}
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold text-foreground font-mono leading-tight">{connection.name}</p>
            <p className="truncate text-[11px] text-muted-foreground font-mono mt-0.5">
              {connection.host}:{connection.port}/<span className="text-muted-foreground/80">{connection.database}</span>
            </p>
            <p className="truncate text-[10px] text-muted-foreground/50 font-mono">{connection.username}</p>
            {connection.tags && connection.tags.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1">
                {connection.tags.map((tag) => (
                  <span
                    key={tag}
                    className={cn(
                      'rounded-sm border px-1.5 py-0.5 text-[9px] font-mono uppercase tracking-[0.12em]',
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

          {/* Actions (visible on hover) */}
          <div className="flex shrink-0 items-center gap-1.5 mt-0.5">
            {/* Status dot */}
            <div className="relative flex items-center justify-center h-4 w-4">
              <span
                className={cn(
                  'relative z-10 h-2 w-2 rounded-full block',
                  health === 'healthy' && 'bg-green-500',
                  health === 'unhealthy' && 'bg-red-500',
                  health === 'unknown' && 'bg-muted-foreground/30 animate-pulse'
                )}
              />
              {health === 'healthy' && (
                <span className="absolute h-2 w-2 rounded-full bg-green-500 animate-glow-ping" />
              )}
            </div>

            {/* Edit */}
            <button
              onClick={handleEdit}
              className="rounded-sm p-1 opacity-0 transition-all duration-150 group-hover:opacity-100 text-muted-foreground/60 hover:text-amber-500 hover:bg-amber-500/10"
              title="Edit connection"
            >
              <Pencil className="h-3 w-3" />
            </button>

            {/* Delete */}
            <button
              onClick={handleDelete}
              className={cn(
                'rounded-sm p-1 opacity-0 transition-all duration-150 group-hover:opacity-100',
                confirmDelete
                  ? 'bg-destructive text-destructive-foreground opacity-100'
                  : 'text-muted-foreground/60 hover:text-foreground hover:bg-muted'
              )}
              title={confirmDelete ? 'Click again to confirm' : 'Delete'}
            >
              <Trash2 className="h-3 w-3" />
            </button>
          </div>
        </div>

        {/* Footer: type tag + retest */}
        <div className="mt-3 flex items-center justify-between">
          <span className="rounded-sm border border-blue-500/15 bg-blue-500/5 px-1.5 py-0.5 text-[9px] font-mono text-blue-400/60 uppercase tracking-[0.12em]">
            {connection.type || 'postgres'}
          </span>

          {/* Retest button — small clickable text */}
          <button
            onClick={handleRetest}
            className={cn(
              'flex items-center gap-1 text-[10px] font-mono text-muted-foreground/40 hover:text-muted-foreground transition-colors',
              retesting && 'pointer-events-none'
            )}
            title="Re-test connection"
          >
            <RefreshCw className={cn('h-2.5 w-2.5', retesting && 'animate-spin')} />
            {retesting ? 'testing…' : 'test'}
          </button>
        </div>
      </div>
    </div>
  )
}
