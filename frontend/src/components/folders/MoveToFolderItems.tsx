import { CornerLeftUp, Folder } from 'lucide-react'
import { DropdownMenuItem } from '@/components/ui/dropdown-menu'
import { flattenFolders, isWithinFolder } from '@/lib/connectionFolders'
import { useFoldersStore } from '@/stores/folders'

interface MoveToFolderItemsProps {
  // Where the item is now; '' for top level.
  currentFolderId: string
  // Set when moving a folder: it cannot go into itself or below itself.
  movingFolderId?: string
  onMove: (folderId: string) => void
}

// Menu items of a "Move to" list: top level, then every folder indented by depth.
export function MoveToFolderItems({ currentFolderId, movingFolderId, onMove }: MoveToFolderItemsProps) {
  const folders = useFoldersStore((state) => state.folders)

  return (
    <>
      <DropdownMenuItem
        disabled={currentFolderId === ''}
        onSelect={() => onMove('')}
        className="gap-2 font-mono text-xs"
      >
        <CornerLeftUp className="h-3.5 w-3.5 text-muted-foreground" />
        Top level
      </DropdownMenuItem>
      {flattenFolders(folders).map(({ folder, depth }) => (
        <DropdownMenuItem
          key={folder.id}
          disabled={
            folder.id === currentFolderId ||
            (movingFolderId !== undefined && isWithinFolder(folders, folder.id, movingFolderId))
          }
          onSelect={() => onMove(folder.id)}
          className="gap-2 font-mono text-xs"
          style={{ paddingLeft: `${8 + depth * 14}px` }}
        >
          <Folder className="h-3.5 w-3.5 shrink-0 text-amber-500/80" />
          <span className="truncate">{folder.name}</span>
        </DropdownMenuItem>
      ))}
    </>
  )
}
