import { ClipboardCopy, Download } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'

/**
 * Shared "Copy" / "Export" toolbar controls for table-shaped results (SQL
 * console results, PostgreSQL table view). One component so both surfaces get
 * the same options and wording instead of drifting apart.
 *
 * Cell and row copy live in each surface's own right-click context menu
 * (they need per-cell/per-row context this component doesn't have) — this is
 * only the "selection" and "whole loaded result" granularities, plus export
 * (which the task scope always treats as "whole loaded result", never a
 * partial selection).
 */
export interface TableExportMenuProps {
  totalRowCount: number
  selectedRowCount: number
  onCopy: (format: 'tsv' | 'json', scope: 'all' | 'selected') => void
  onExport: (format: 'csv' | 'json') => void
  disabled?: boolean
}

export function TableExportMenu({ totalRowCount, selectedRowCount, onCopy, onExport, disabled }: TableExportMenuProps) {
  const noRows = totalRowCount === 0
  return (
    <div className="flex items-center gap-1.5">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-8 gap-1.5 font-mono text-[11px]"
            disabled={disabled || noRows}
          >
            <ClipboardCopy className="h-3.5 w-3.5" />
            Copy
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuLabel>All {totalRowCount} loaded row{totalRowCount === 1 ? '' : 's'}</DropdownMenuLabel>
          <DropdownMenuItem onClick={() => onCopy('tsv', 'all')}>as TSV (paste into a spreadsheet)</DropdownMenuItem>
          <DropdownMenuItem onClick={() => onCopy('json', 'all')}>as JSON</DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuLabel>
            {selectedRowCount > 0 ? `Selected (${selectedRowCount})` : 'Selected (none)'}
          </DropdownMenuLabel>
          <DropdownMenuItem disabled={selectedRowCount === 0} onClick={() => onCopy('tsv', 'selected')}>
            as TSV
          </DropdownMenuItem>
          <DropdownMenuItem disabled={selectedRowCount === 0} onClick={() => onCopy('json', 'selected')}>
            as JSON
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-8 gap-1.5 font-mono text-[11px]"
            disabled={disabled || noRows}
          >
            <Download className="h-3.5 w-3.5" />
            Export
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuLabel>All {totalRowCount} loaded row{totalRowCount === 1 ? '' : 's'}</DropdownMenuLabel>
          <DropdownMenuItem onClick={() => onExport('csv')}>as CSV</DropdownMenuItem>
          <DropdownMenuItem onClick={() => onExport('json')}>as JSON</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}
