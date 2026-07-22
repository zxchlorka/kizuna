import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { ListTree, Search } from 'lucide-react'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { JsonFieldTreeNode } from '@/components/kafka/JsonFieldTreeNode'
import { buildSchemaTree, type SampleRow, type SchemaNode } from '@/lib/jsonSchemaSample'
import { cn } from '@/lib/utils'

interface JsonFieldPickerDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  // Already-loaded page rows; the picker samples these and never triggers a fetch.
  messages: readonly SampleRow[]
  // Called with the canonical path when the user confirms with "Use field".
  onUseField: (path: string) => void
}

interface VisibleEntry {
  node: SchemaNode
  depth: number
}

// pruneTree keeps nodes whose label matches the filter plus their ancestors. A
// matched node keeps its whole subtree so the user can still drill into it.
function pruneTree(node: SchemaNode, needle: string): SchemaNode | null {
  if (node.label.toLowerCase().includes(needle)) {
    return node
  }
  const children: SchemaNode[] = []
  for (const child of node.children) {
    const pruned = pruneTree(child, needle)
    if (pruned) children.push(pruned)
  }
  if (children.length === 0) return null
  return { ...node, children }
}

function collectExpandablePaths(node: SchemaNode, acc: Set<string>): void {
  for (const child of node.children) {
    if (child.expandable) acc.add(child.path)
    collectExpandablePaths(child, acc)
  }
}

function flattenVisible(node: SchemaNode, expanded: Set<string>, depth: number, out: VisibleEntry[]): void {
  for (const child of node.children) {
    out.push({ node: child, depth })
    if (child.expandable && expanded.has(child.path)) {
      flattenVisible(child, expanded, depth + 1, out)
    }
  }
}

export function JsonFieldPickerDialog({ open, onOpenChange, messages, onUseField }: JsonFieldPickerDialogProps) {
  const treeRef = useRef<HTMLDivElement>(null)

  const { root, sampleCount, truncated } = useMemo(() => buildSchemaTree(messages), [messages])

  const [filter, setFilter] = useState('')
  const [userExpanded, setUserExpanded] = useState<Set<string>>(() => new Set())
  const [focusedPath, setFocusedPath] = useState<string | null>(null)
  const [selectedPath, setSelectedPath] = useState<string | null>(null)

  const needle = filter.trim().toLowerCase()
  const filtering = needle !== ''

  const displayRoot = useMemo<SchemaNode>(() => {
    if (!filtering) return root
    const children = root.children
      .map((child) => pruneTree(child, needle))
      .filter((child): child is SchemaNode => child !== null)
    return { ...root, children }
  }, [root, filtering, needle])

  // While filtering, everything is force-expanded so matches are visible; the
  // user's manual expand/collapse state applies only when not filtering.
  const effectiveExpanded = useMemo(() => {
    if (!filtering) return userExpanded
    const all = new Set<string>()
    collectExpandablePaths(displayRoot, all)
    return all
  }, [filtering, userExpanded, displayRoot])

  const visible = useMemo(() => {
    const out: VisibleEntry[] = []
    flattenVisible(displayRoot, effectiveExpanded, 0, out)
    return out
  }, [displayRoot, effectiveExpanded])

  // Reset picker state each time it opens; auto-expand the first object level so
  // top-level structure is visible without a click.
  useEffect(() => {
    if (!open) return
    setFilter('')
    setSelectedPath(null)
    const firstLevel = new Set<string>()
    for (const child of root.children) {
      if (child.expandable) firstLevel.add(child.path)
    }
    setUserExpanded(firstLevel)
    setFocusedPath(root.children[0]?.path ?? null)
  }, [open, root])

  // Keep the focused row scrolled into view.
  useEffect(() => {
    if (!focusedPath || !treeRef.current || typeof CSS === 'undefined') return
    const el = treeRef.current.querySelector<HTMLElement>(`[data-path="${CSS.escape(focusedPath)}"]`)
    el?.scrollIntoView({ block: 'nearest' })
  }, [focusedPath])

  const toggle = (path: string) => {
    setUserExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }

  const selectNode = (node: SchemaNode) => {
    setFocusedPath(node.path)
    setSelectedPath(node.path)
  }

  const focusAt = (index: number) => {
    const entry = visible[index]
    if (entry) setFocusedPath(entry.node.path)
  }

  const handleTreeKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (visible.length === 0) return
    const index = visible.findIndex((entry) => entry.node.path === focusedPath)
    const current = index >= 0 ? visible[index] : undefined

    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault()
        focusAt(index < 0 ? 0 : Math.min(index + 1, visible.length - 1))
        break
      case 'ArrowUp':
        event.preventDefault()
        focusAt(index <= 0 ? 0 : index - 1)
        break
      case 'ArrowRight':
        event.preventDefault()
        if (current?.node.expandable && !filtering && !effectiveExpanded.has(current.node.path)) {
          toggle(current.node.path)
        } else if (current?.node.expandable) {
          focusAt(index + 1)
        }
        break
      case 'ArrowLeft':
        event.preventDefault()
        if (current?.node.expandable && effectiveExpanded.has(current.node.path) && !filtering) {
          toggle(current.node.path)
        } else if (current) {
          // Jump to the nearest shallower ancestor row.
          for (let i = index - 1; i >= 0; i -= 1) {
            if (visible[i].depth < current.depth) {
              focusAt(i)
              break
            }
          }
        }
        break
      case 'Enter':
        event.preventDefault()
        if (!current) break
        if (current.node.expandable && !filtering) toggle(current.node.path)
        else if (current.node.selectable) selectNode(current.node)
        break
      case 'Home':
        event.preventDefault()
        focusAt(0)
        break
      case 'End':
        event.preventDefault()
        focusAt(visible.length - 1)
        break
      default:
        break
    }
  }

  const isEmpty = sampleCount === 0
  const noMatches = filtering && visible.length === 0

  const useSelected = () => {
    if (!selectedPath) return
    onUseField(selectedPath)
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ListTree className="h-4 w-4 text-orange-500" />
            Choose a field
          </DialogTitle>
          <DialogDescription>
            {isEmpty
              ? 'Pick a field from the sampled JSON messages.'
              : `Sampled ${sampleCount} JSON ${sampleCount === 1 ? 'message' : 'messages'}${
                  truncated ? ' · large payload, tree truncated' : ''
                }`}
          </DialogDescription>
        </DialogHeader>

        {isEmpty ? (
          <div className="rounded-sm border border-dashed border-border bg-muted/10 px-4 py-8 text-center">
            <ListTree className="mx-auto h-6 w-6 text-muted-foreground" />
            <p className="mt-3 text-sm font-medium text-foreground">No JSON messages to sample</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Load messages in this topic, then reopen the picker. You can also type the path by hand.
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="relative">
              <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <input
                value={filter}
                onChange={(event) => setFilter(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'ArrowDown') {
                    event.preventDefault()
                    treeRef.current?.focus()
                    focusAt(0)
                  }
                }}
                placeholder="Filter fields by name"
                aria-label="Filter fields by name"
                spellCheck={false}
                autoComplete="off"
                className="h-8 w-full rounded-sm border border-border bg-background pl-7 pr-2 font-mono text-xs outline-none placeholder:text-muted-foreground focus:border-orange-500/50"
              />
            </div>

            <div
              ref={treeRef}
              role="tree"
              aria-label="JSON fields"
              tabIndex={0}
              onKeyDown={handleTreeKeyDown}
              onFocus={() => {
                if (!focusedPath) focusAt(0)
              }}
              className="max-h-[52vh] min-h-[16rem] overflow-y-auto rounded-sm border border-border bg-background/40 p-1 outline-none focus-visible:ring-1 focus-visible:ring-orange-500/40"
            >
              {noMatches ? (
                <p className="px-2 py-6 text-center font-mono text-[11px] text-muted-foreground">
                  No fields match “{filter.trim()}”.
                </p>
              ) : (
                displayRoot.children.map((child) => (
                  <JsonFieldTreeNode
                    key={child.path}
                    node={child}
                    depth={0}
                    expanded={effectiveExpanded}
                    focusedPath={focusedPath}
                    selectedPath={selectedPath}
                    onToggle={toggle}
                    onFocus={setFocusedPath}
                    onSelect={selectNode}
                  />
                ))
              )}
            </div>

            <p className="text-[11px] text-muted-foreground">
              Only scalar fields can be selected. Array items fold into a single{' '}
              <span className="font-mono text-cyan-600 dark:text-cyan-400">[ ]</span> step.
            </p>
          </div>
        )}

        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-3">
          <div className="min-w-0 flex-1">
            {selectedPath ? (
              <span className="block truncate font-mono text-xs text-foreground" title={selectedPath}>
                {selectedPath}
              </span>
            ) : (
              <span className="font-mono text-[11px] text-muted-foreground">Select a scalar field to continue</span>
            )}
          </div>
          <div className="flex items-center gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button
              type="button"
              size="sm"
              className={cn('bg-orange-500 text-white hover:bg-orange-400', !selectedPath && 'pointer-events-none opacity-50')}
              disabled={!selectedPath}
              onClick={useSelected}
            >
              Use field
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
