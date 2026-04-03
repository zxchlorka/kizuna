import { Database, FileSearch, Table2, SearchX } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

type EmptyStateVariant = 'no_connections' | 'no_tables' | 'no_data' | 'no_results'

interface EmptyStateProps {
  variant: EmptyStateVariant
  title?: string
  description?: string
  compact?: boolean
  actionLabel?: string
  onAction?: () => void
  className?: string
}

const content: Record<EmptyStateVariant, { title: string; description: string; icon: typeof Database }> = {
  no_connections: {
    title: 'No connections',
    description: 'Add your first connection to start exploring your infrastructure.',
    icon: Database,
  },
  no_tables: {
    title: 'No objects here',
    description: 'This schema does not have visible tables or indexes yet.',
    icon: Table2,
  },
  no_data: {
    title: 'No rows yet',
    description: 'This table is empty. Insert a row or create structure around it.',
    icon: FileSearch,
  },
  no_results: {
    title: 'No matching rows',
    description: 'Adjust or clear filters to bring records back into view.',
    icon: SearchX,
  },
}

export function EmptyState({
  variant,
  title,
  description,
  compact = false,
  actionLabel,
  onAction,
  className,
}: EmptyStateProps) {
  const preset = content[variant]
  const Icon = preset.icon

  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center rounded-sm border border-dashed border-border/80 bg-background/70 text-center',
        compact ? 'px-4 py-5' : 'px-8 py-12',
        className
      )}
    >
      <div className={cn('mb-3 flex items-center justify-center rounded-sm border border-border bg-muted/30', compact ? 'h-10 w-10' : 'h-14 w-14')}>
        <Icon className={cn('text-accent-amber', compact ? 'h-4 w-4' : 'h-5 w-5')} />
      </div>
      <p className={cn('font-mono text-foreground', compact ? 'text-xs' : 'text-sm')}>{title ?? preset.title}</p>
      <p className={cn('mt-1 max-w-sm text-muted-foreground', compact ? 'text-[11px]' : 'text-xs')}>{description ?? preset.description}</p>
      {actionLabel && onAction && (
        <Button size="sm" variant="outline" className="mt-4 h-8 gap-2 font-mono text-xs" onClick={onAction}>
          {actionLabel}
        </Button>
      )}
    </div>
  )
}
