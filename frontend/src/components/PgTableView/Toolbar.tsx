import { Check, Link2, Pencil, Plus, RefreshCw, Trash2, X } from 'lucide-react'
import { DDLDropdown, type TableDDLAction } from '@/components/DDL/DDLDropdown'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { cn } from '@/lib/utils'

interface ToolbarProps {
  onRefresh: () => void
  onAddRow: () => void
  onDeleteSelected: () => void
  canDeleteRows: boolean
  selectedCount: number
  pageSize: number
  onPageSizeChange: (n: number) => void
  loading: boolean
  editMode: boolean
  pendingCount: number
  onToggleEditMode: () => void
  onSaveAll: () => void
  onCancelAll: () => void
  onDDLAction: (action: TableDDLAction) => void
  canOpenReferencedBy: boolean
  onOpenReferencedBy: () => void
}

export function Toolbar({
  onRefresh,
  onAddRow,
  onDeleteSelected,
  canDeleteRows,
  selectedCount,
  pageSize,
  onPageSizeChange,
  loading,
  editMode,
  pendingCount,
  onToggleEditMode,
  onSaveAll,
  onCancelAll,
  onDDLAction,
  canOpenReferencedBy,
  onOpenReferencedBy,
}: ToolbarProps) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-border bg-background px-3 py-2">
      <div className="flex items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          onClick={onRefresh}
          disabled={loading}
          className="h-8 gap-1.5 px-2.5"
        >
          <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />
          <span>Refresh</span>
        </Button>

        <Button
          variant={editMode ? 'secondary' : 'outline'}
          size="sm"
          onClick={onToggleEditMode}
          className="h-8 gap-1.5 px-2.5"
        >
          <Pencil className="h-3.5 w-3.5" />
          <span>{editMode ? 'Editing' : 'Edit mode'}</span>
        </Button>

        <Button variant="outline" size="sm" onClick={onAddRow} className="h-8 gap-1.5 px-2.5">
          <Plus className="h-3.5 w-3.5" />
          <span>Add Row</span>
        </Button>

        <DDLDropdown disabled={loading} onAction={onDDLAction} />

        <Button
          variant="outline"
          size="sm"
          onClick={onOpenReferencedBy}
          disabled={!canOpenReferencedBy}
          className="h-8 gap-1.5 px-2.5"
        >
          <Link2 className="h-3.5 w-3.5" />
          <span>Referenced By</span>
        </Button>

        {selectedCount > 0 && (
          <Button
            variant="destructive"
            size="sm"
            onClick={onDeleteSelected}
            disabled={!canDeleteRows}
            className="h-8 gap-1.5 px-2.5"
          >
            <Trash2 className="h-3.5 w-3.5" />
            <span>
              {canDeleteRows
                ? editMode
                  ? `Mark delete (${selectedCount})`
                  : `Delete ${selectedCount}`
                : 'Delete unavailable (no PK)'}
            </span>
          </Button>
        )}

        {editMode && (
          <>
            <Button size="sm" onClick={onSaveAll} className="h-8 gap-1.5 px-2.5">
              <Check className="h-3.5 w-3.5" />
              <span>Save all</span>
            </Button>
            <Button variant="outline" size="sm" onClick={onCancelAll} className="h-8 gap-1.5 px-2.5">
              <X className="h-3.5 w-3.5" />
              <span>Cancel all</span>
            </Button>
          </>
        )}
      </div>

      <div className="flex items-center gap-3">
        {editMode && (
          <span className="inline-flex items-center rounded border border-amber-500/30 bg-amber-500/10 px-2 py-1 text-xs text-amber-500">
            Pending changes: {pendingCount}
          </span>
        )}

        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">Rows per page:</span>
          <Select value={String(pageSize)} onValueChange={(val) => onPageSizeChange(Number(val))}>
            <SelectTrigger className="h-8 w-[80px] text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="50">50</SelectItem>
              <SelectItem value="100">100</SelectItem>
              <SelectItem value="500">500</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>
    </div>
  )
}
