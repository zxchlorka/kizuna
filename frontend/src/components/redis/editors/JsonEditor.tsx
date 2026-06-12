import { useMemo, useState } from 'react'
import { Braces, ChevronDown, ChevronRight, Pencil, Save } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'
import type { TableRow } from '@/types/api'

interface JsonEditorProps {
  rows: TableRow[]
  saving: boolean
  onSave: (path: string, value: unknown) => Promise<void> | void
}

interface JsonNodeRow {
  path: string
  parentPath: string
  type: string
  depth: number
  value: unknown
  isLeaf: boolean
}

interface DraftParseResult {
  value: unknown
  error?: string
}

function parseJsonRows(rows: TableRow[]): JsonNodeRow[] {
  return rows.map((row) => ({
    path: String(row.path ?? '$'),
    parentPath: String(row.parent_path ?? ''),
    type: String(row.type ?? 'unknown'),
    depth: Number(row.depth ?? 0),
    value: row.value,
    isLeaf: Boolean(row.is_leaf),
  }))
}

function formatJsonValue(value: unknown, type: string): string {
  if (type === 'string') {
    return String(value ?? '')
  }
  if (value === null || value === undefined) {
    return 'null'
  }
  if (typeof value === 'object') {
    return JSON.stringify(value, null, 2)
  }
  return String(value)
}

function parseDraftValue(type: string, draft: string): DraftParseResult {
  switch (type) {
    case 'number': {
      const value = Number(draft)
      if (Number.isNaN(value)) {
        return { value: draft, error: 'Enter a valid number.' }
      }
      return { value }
    }
    case 'boolean': {
      const normalized = draft.trim().toLowerCase()
      if (normalized === 'true') {
        return { value: true }
      }
      if (normalized === 'false') {
        return { value: false }
      }
      return { value: draft, error: 'Enter `true` or `false`.' }
    }
    case 'null':
      return { value: null }
    case 'string':
      return { value: draft }
    default:
      try {
        return { value: JSON.parse(draft) }
      } catch {
        return { value: draft }
      }
  }
}

export function JsonEditor({ rows, saving, onSave }: JsonEditorProps) {
  const nodes = useMemo(() => parseJsonRows(rows), [rows])
  const childrenByParent = useMemo(() => {
    const map = new Map<string, JsonNodeRow[]>()
    nodes.forEach((node) => {
      const existing = map.get(node.parentPath) ?? []
      existing.push(node)
      map.set(node.parentPath, existing)
    })
    return map
  }, [nodes])

  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(['$', '$.']))
  const [editingPath, setEditingPath] = useState<string | null>(null)
  const [draftValue, setDraftValue] = useState('')
  const [editorError, setEditorError] = useState<string | null>(null)
  const [selectedPath, setSelectedPath] = useState('$')

  const rootNode = nodes.find((node) => node.path === '$') ?? null
  const visibleRoots = childrenByParent.get('') ?? (rootNode ? [rootNode] : [])

  const toggleExpanded = (path: string) => {
    setExpanded((current) => {
      const next = new Set(current)
      if (next.has(path)) {
        next.delete(path)
      } else {
        next.add(path)
      }
      return next
    })
  }

  const renderNode = (node: JsonNodeRow) => {
    const children = childrenByParent.get(node.path) ?? []
    const isExpanded = expanded.has(node.path)
    const isEditing = editingPath === node.path

    return (
      <div key={node.path}>
        <div
          className={cn(
            'flex items-start gap-2 rounded-sm px-3 py-2 text-sm',
            selectedPath === node.path ? 'bg-cyan-500/10' : 'hover:bg-muted/40'
          )}
          style={{ paddingLeft: `${12 + node.depth * 18}px` }}
        >
          {children.length > 0 ? (
            <button type="button" className="mt-0.5 text-muted-foreground" onClick={() => toggleExpanded(node.path)}>
              {isExpanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
            </button>
          ) : (
            <span className="mt-0.5 h-4 w-4" />
          )}

          <button type="button" className="min-w-0 flex-1 text-left" onClick={() => setSelectedPath(node.path)}>
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-mono text-xs text-foreground">{node.path}</span>
              <span className="rounded-sm border border-cyan-500/20 bg-cyan-500/10 px-2 py-0.5 text-[10px] uppercase tracking-[0.14em] text-cyan-700 dark:text-cyan-300">
                {node.type}
              </span>
            </div>
            {node.isLeaf ? (
              isEditing ? (
                <div className="mt-2 flex flex-col gap-2">
                  {String(draftValue).includes('\n') || draftValue.length > 80 ? (
                    <Textarea
                      value={draftValue}
                      onChange={(event) => {
                        setDraftValue(event.target.value)
                        setEditorError(null)
                      }}
                      className="font-mono text-xs"
                      rows={4}
                    />
                  ) : (
                    <Input
                      value={draftValue}
                      onChange={(event) => {
                        setDraftValue(event.target.value)
                        setEditorError(null)
                      }}
                      className="h-8 font-mono text-xs"
                    />
                  )}
                  {editorError ? <div className="font-mono text-[11px] text-destructive">{editorError}</div> : null}
                  <div className="flex items-center gap-2">
                    <Button
                      type="button"
                      size="sm"
                      className="h-7 gap-1.5 font-mono text-[11px]"
                      disabled={saving}
                      onClick={() => {
                        const parsed = parseDraftValue(node.type, draftValue)
                        if (parsed.error) {
                          setEditorError(parsed.error)
                          return
                        }
                        void Promise.resolve(onSave(node.path, parsed.value)).then(() => {
                          setEditingPath(null)
                          setEditorError(null)
                        }).catch(() => {
                          // Parent components surface persistence failures via toast.
                        })
                      }}
                    >
                      <Save className="h-3.5 w-3.5" />
                      Save
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      className="h-7 font-mono text-[11px]"
                      onClick={() => {
                        setEditingPath(null)
                        setEditorError(null)
                      }}
                    >
                      Cancel
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="mt-1 flex items-center gap-2">
                  <span className="font-mono text-xs text-muted-foreground">{formatJsonValue(node.value, node.type)}</span>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    className="h-6 gap-1 px-2 font-mono text-[10px]"
                    onClick={() => {
                      setSelectedPath(node.path)
                      setEditingPath(node.path)
                      setDraftValue(formatJsonValue(node.value, node.type))
                      setEditorError(null)
                    }}
                  >
                    <Pencil className="h-3 w-3" />
                    Edit
                  </Button>
                </div>
              )
            ) : (
              <div className="mt-1 font-mono text-xs text-muted-foreground">{children.length} nested item(s)</div>
            )}
          </button>
        </div>

        {children.length > 0 && isExpanded && children.map(renderNode)}
      </div>
    )
  }

  return (
    <div className="overflow-hidden rounded-sm border border-border bg-card">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3">
        <div>
          <div className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground">Redis JSON</div>
          <div className="mt-1 flex items-center gap-2 text-sm text-foreground">
            <Braces className="h-4 w-4 text-cyan-500" />
            Inline edits are limited to existing leaf paths.
          </div>
        </div>
        <div className="rounded-sm border border-border bg-muted/40 px-3 py-2 font-mono text-xs text-muted-foreground">
          Path: {selectedPath}
        </div>
      </div>

      {nodes.length === 0 ? (
        <div className="px-4 py-8 text-sm text-muted-foreground">No JSON document found for this key.</div>
      ) : (
        <div className="py-2">{visibleRoots.map(renderNode)}</div>
      )}
    </div>
  )
}
