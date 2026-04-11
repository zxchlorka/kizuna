import { ArrowLeft } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

interface BreadcrumbItem {
  tabId: string
  label: string
  filterLabel?: string
}

interface FkBreadcrumbProps {
  items: BreadcrumbItem[]
  onBack: () => void
}

export function FkBreadcrumb({ items, onBack }: FkBreadcrumbProps) {
  if (items.length < 2) {
    return null
  }

  const current = items[items.length - 1]

  return (
    <div className="mx-2 mt-2 flex items-center gap-2 rounded border border-border bg-muted/15 px-3 py-2">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-7 gap-1 px-2 font-mono text-[11px]"
        onClick={onBack}
      >
        <ArrowLeft className="h-3.5 w-3.5" />
        Back
      </Button>

      <div className="flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
        {items.map((item, index) => (
          <div key={`${item.tabId}:${index}`} className="flex min-w-0 items-center gap-1">
            {index > 0 && <span className="text-muted-foreground/60">→</span>}
            <span
              className={cn(
                'truncate',
                item.tabId === current.tabId && 'font-medium text-foreground'
              )}
              title={item.filterLabel ? `${item.label} (${item.filterLabel})` : item.label}
            >
              {item.label}
              {item.tabId === current.tabId && item.filterLabel ? ` (${item.filterLabel})` : ''}
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}
