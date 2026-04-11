import { Filter } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

interface SchemaFilterButtonProps {
  hiddenCount: number
  disabled?: boolean
  onClick: () => void
}

export function SchemaFilterButton({ hiddenCount, disabled = false, onClick }: SchemaFilterButtonProps) {
  return (
    <Button
      type="button"
      variant={hiddenCount > 0 ? 'secondary' : 'ghost'}
      size="icon"
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'relative h-7 w-7 rounded-sm border border-border/70',
        hiddenCount === 0 && 'border-transparent text-muted-foreground hover:border-border hover:text-foreground'
      )}
      title={hiddenCount > 0 ? `${hiddenCount} schemas hidden` : 'Choose visible schemas'}
      aria-label="Choose visible schemas"
    >
      <Filter className="h-3.5 w-3.5" />
      {hiddenCount > 0 && (
        <span className="absolute -right-1 -top-1 min-w-4 rounded-full bg-foreground px-1 text-[10px] font-semibold leading-4 text-background">
          {hiddenCount}
        </span>
      )}
    </Button>
  )
}
