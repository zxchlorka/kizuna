import { ExternalLink } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import type { ColumnMeta } from '@/types/api'

interface FkLinkCellProps {
  value: unknown
  colMeta: ColumnMeta
  previewValue: string
  title: string
  onNavigate: (colMeta: ColumnMeta, value: unknown) => void
}

export function FkLinkCell({ value, colMeta, previewValue, title, onNavigate }: FkLinkCellProps) {
  const targetTable = colMeta.fk_table
  const targetColumn = colMeta.fk_column

  if (!targetTable || !targetColumn) {
    return (
      <div
        className={cn(
          'block min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap',
          previewValue === 'Empty' && 'italic text-muted-foreground'
        )}
        title={title}
      >
        {previewValue}
      </div>
    )
  }

  return (
    <>
      <div
        className={cn(
          'block min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap',
          previewValue === 'Empty' && 'italic text-muted-foreground'
        )}
        title={title}
      >
        {previewValue}
      </div>
      <TooltipProvider delayDuration={150}>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              className="ml-1 rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-blue-500"
              onClick={(event) => {
                event.stopPropagation()
                onNavigate(colMeta, value)
              }}
              aria-label={`Jump to ${targetTable} where ${targetColumn} = ${String(value)}`}
            >
              <ExternalLink className="h-3.5 w-3.5" />
            </button>
          </TooltipTrigger>
          <TooltipContent>
            {`Jump to ${targetTable} where ${targetColumn} = ${String(value)}`}
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    </>
  )
}
