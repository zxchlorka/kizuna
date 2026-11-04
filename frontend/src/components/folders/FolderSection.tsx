import type { ReactNode } from 'react'
import { ChevronRight, Folder, FolderOpen, FolderPlus, MoreHorizontal, Pencil, Trash2, FolderInput } from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { FolderNameInput } from '@/components/folders/FolderNameInput'
import { MoveToFolderItems } from '@/components/folders/MoveToFolderItems'
import type { FolderTreeControls } from '@/components/folders/ConnectionFolderTree'
import type { FolderNode } from '@/lib/connectionFolders'
import { cn } from '@/lib/utils'
import type { Connection } from '@/types/api'

interface FolderSectionProps {
  node: FolderNode
  controls: FolderTreeControls
  renderConnections: (connections: Connection[]) => ReactNode
}

export function FolderSection({ node, controls, renderConnections }: FolderSectionProps) {
  const { folder } = node
  const parentId = folder.parent_id ?? ''
  const open = controls.isOpen(folder.id)
  const over = controls.overFolderId === folder.id
  const renaming = controls.renamingId === folder.id
  const empty = node.children.length === 0 && node.connections.length === 0

  return (
    <section
      aria-label={folder.name}
      onDragOver={(e) => controls.dragOver(e, folder.id)}
      onDrop={(e) => controls.drop(e, folder.id)}
      className={cn('rounded-sm transition-colors duration-150', over && 'bg-amber-500/[0.05] ring-1 ring-amber-500/40')}
    >
      {renaming ? (
        <div className="px-1">
          <FolderNameInput
            initial={folder.name}
            onSubmit={(name) => controls.rename(folder.id, name)}
            onCancel={() => controls.setRenamingId(null)}
          />
        </div>
      ) : (
        <div
          draggable
          onDragStart={(e) => controls.dragStart(e, { kind: 'folder', id: folder.id, folderId: parentId })}
          onDragEnd={controls.dragEnd}
          className="group/folder flex h-8 items-center gap-2 px-1"
        >
          <button
            type="button"
            onClick={() => controls.toggle(folder.id)}
            disabled={controls.searching}
            title={controls.searching ? 'Folders stay open while searching' : undefined}
            aria-expanded={open}
            className="flex min-w-0 items-center gap-2 rounded-sm py-1 pr-1 text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-amber-500/60 disabled:cursor-default"
          >
            <ChevronRight
              className={cn('h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform duration-150', open && 'rotate-90')}
            />
            {open ? (
              <FolderOpen className="h-4 w-4 shrink-0 text-amber-500" />
            ) : (
              <Folder className="h-4 w-4 shrink-0 text-amber-500/80" />
            )}
            <span className="truncate font-mono text-sm font-medium text-foreground">{folder.name}</span>
          </button>
          <span className="font-mono text-[11px] tabular-nums text-muted-foreground" title="Connections in this folder and below">
            {node.total}
          </span>
          <div className="h-px flex-1 bg-border/50" />
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                aria-label={`Folder actions for ${folder.name}`}
                className="rounded-sm p-1 text-muted-foreground opacity-0 transition-opacity hover:bg-amber-500/10 hover:text-amber-500 focus-visible:opacity-100 group-hover/folder:opacity-100 data-[state=open]:opacity-100"
              >
                <MoreHorizontal className="h-3.5 w-3.5" />
              </button>
            </DropdownMenuTrigger>
            {/* New subfolder and Rename open an autofocused input; handing focus back
                to the trigger on close would take it straight away from that input. */}
            <DropdownMenuContent align="end" className="min-w-48" onCloseAutoFocus={(e) => e.preventDefault()}>
              <DropdownMenuItem className="gap-2 text-xs" onSelect={() => controls.startCreating(folder.id)}>
                <FolderPlus className="h-3.5 w-3.5" />
                New subfolder
              </DropdownMenuItem>
              <DropdownMenuItem className="gap-2 text-xs" onSelect={() => controls.setRenamingId(folder.id)}>
                <Pencil className="h-3.5 w-3.5" />
                Rename
              </DropdownMenuItem>
              <DropdownMenuSub>
                <DropdownMenuSubTrigger className="gap-2 text-xs">
                  <FolderInput className="h-3.5 w-3.5" />
                  Move to
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent className="max-h-80 overflow-y-auto">
                  <MoveToFolderItems
                    currentFolderId={parentId}
                    movingFolderId={folder.id}
                    onMove={(target) => void controls.moveFolder(folder.id, target)}
                  />
                </DropdownMenuSubContent>
              </DropdownMenuSub>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                className="gap-2 text-xs text-red-500 focus:text-red-400"
                onSelect={() => void controls.removeFolder(folder.id)}
              >
                <Trash2 className="h-3.5 w-3.5" />
                Delete folder
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      )}

      {open && (
        <div className="ml-[11px] space-y-3 border-l border-border/60 pb-2 pl-5 pt-1">
          {controls.creatingIn === folder.id && (
            <FolderNameInput
              placeholder="Subfolder name"
              onSubmit={(name) => controls.create(name, folder.id)}
              onCancel={() => controls.startCreating(null)}
            />
          )}
          {node.children.map((child) => (
            <FolderSection key={child.folder.id} node={child} controls={controls} renderConnections={renderConnections} />
          ))}
          {node.connections.length > 0 && renderConnections(node.connections)}
          {empty && controls.creatingIn !== folder.id && (
            <p className="py-1 font-mono text-[11px] text-muted-foreground/70">
              Empty. Drag a connection here or use Move to on its card.
            </p>
          )}
        </div>
      )}
    </section>
  )
}
