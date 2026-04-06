import { ChevronDown, FilePlus2, ListPlus, ListX, ScanSearch, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'

export type TableDDLAction = 'drop_table' | 'add_column' | 'drop_column' | 'create_index'

interface DDLDropdownProps {
  disabled?: boolean
  onAction: (action: TableDDLAction) => void
}

const actions: Array<{ action: TableDDLAction; label: string; icon: typeof FilePlus2; destructive?: boolean }> = [
  { action: 'add_column', label: 'Add Column', icon: ListPlus },
  { action: 'create_index', label: 'Create Index', icon: ScanSearch },
  { action: 'drop_table', label: 'Drop Table', icon: Trash2, destructive: true },
  { action: 'drop_column', label: 'Drop Column', icon: ListX, destructive: true },
]

export function DDLDropdown({ disabled = false, onAction }: DDLDropdownProps) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild disabled={disabled}>
        <Button variant="outline" size="sm" className="h-8 gap-1.5 px-2.5 font-mono text-xs">
          DDL
          <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-52">
        <DropdownMenuLabel>Table Actions</DropdownMenuLabel>
        {actions.slice(0, 2).map(({ action, label, icon: Icon }) => (
          <DropdownMenuItem key={action} onSelect={() => onAction(action)}>
            <Icon className="mr-2 h-3.5 w-3.5" />
            {label}
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        {actions.slice(2).map(({ action, label, icon: Icon, destructive }) => (
          <DropdownMenuItem key={action} destructive={destructive} onSelect={() => onAction(action)}>
            <Icon className="mr-2 h-3.5 w-3.5" />
            {label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
