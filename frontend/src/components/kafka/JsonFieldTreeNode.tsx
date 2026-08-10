import { Fragment } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { JsonTypeCategory, SchemaNode } from '@/lib/jsonSchemaSample'

interface JsonFieldTreeNodeProps {
  node: SchemaNode
  depth: number
  expanded: Set<string>
  focusedPath: string | null
  selectedPath: string | null
  onToggle: (path: string) => void
  onFocus: (path: string) => void
  onSelect: (node: SchemaNode) => void
  // Double-click confirms in one gesture: single-click already selects, so the
  // trip to the Use field button is the only thing left between choosing a row
  // and using it.
  onConfirm: (node: SchemaNode) => void
}

// Type badge colours reuse the app's established data vocabulary (see
// KafkaFormatBadge): emerald for strings, sky for numbers, violet for booleans,
// muted for null, and structural cyan/foreground tints for arrays/objects. The
// orange accent is deliberately NOT used here — it is reserved for selection.
const typeBadgeStyles: Record<JsonTypeCategory, string> = {
  string: 'border-emerald-500/20 bg-emerald-500/5 text-emerald-600 dark:text-emerald-400',
  number: 'border-sky-500/20 bg-sky-500/5 text-sky-600 dark:text-sky-400',
  boolean: 'border-violet-500/20 bg-violet-500/5 text-violet-600 dark:text-violet-400',
  null: 'border-border bg-muted/30 text-muted-foreground',
  object: 'border-border bg-muted/20 text-foreground/70',
  array: 'border-cyan-500/20 bg-cyan-500/5 text-cyan-600 dark:text-cyan-400',
}

// Abbreviated so several unioned types still fit the fixed type column without
// breaking the alignment the rest of the row depends on.
const typeAbbrev: Record<JsonTypeCategory, string> = {
  string: 'str',
  number: 'num',
  boolean: 'bool',
  null: 'null',
  object: 'obj',
  array: 'arr',
}

// A sampled value can be a multi-kilobyte token (percent-encoded query strings,
// user agents). CSS truncation alone still forces the browser to lay the whole
// string out, so cap it here and keep the full text in the row's title.
const exampleLimit = 140

// Row template. Every column is a fixed share rather than content-sized, so the
// type, example and presence columns line up straight down the list no matter
// how deep a row sits — the tree indent is absorbed inside the name column.
export const fieldRowGrid = 'grid grid-cols-[minmax(0,1fr)_4.25rem_minmax(0,1.15fr)_2.5rem] items-center gap-2'

export function JsonFieldTreeNode({
  node,
  depth,
  expanded,
  focusedPath,
  selectedPath,
  onToggle,
  onFocus,
  onSelect,
  onConfirm,
}: JsonFieldTreeNodeProps) {
  const isExpanded = expanded.has(node.path)
  const isFocused = focusedPath === node.path
  const isSelected = selectedPath === node.path
  // Present interaction: a node with children opens; otherwise a scalar leaf is
  // picked. Mixed shapes (both) fall through to expand — the rare scalar branch
  // is still reachable by drilling in.
  const primaryAction = node.expandable ? () => onToggle(node.path) : node.selectable ? () => onSelect(node) : undefined

  // Presence is only worth showing when a field is NOT in every sampled message.
  // Rendering "100/100" on every row buries the handful of rows that carry real
  // information, so a silent presence column reads as "always there" and only a
  // gap in coverage earns a mark.
  const partial = node.sampleCount > 0 && node.seenCount < node.sampleCount
  const presencePct = node.sampleCount > 0 ? Math.round((node.seenCount / node.sampleCount) * 100) : 0

  const example = node.example !== undefined && node.example !== '' ? node.example : null
  const exampleShort = example && example.length > exampleLimit ? `${example.slice(0, exampleLimit)}…` : example

  return (
    <Fragment>
      <div
        data-path={node.path}
        role="treeitem"
        aria-expanded={node.expandable ? isExpanded : undefined}
        aria-selected={isSelected}
        onMouseDown={() => onFocus(node.path)}
        onClick={primaryAction}
        onDoubleClick={node.selectable ? () => onConfirm(node) : undefined}
        className={cn(
          fieldRowGrid,
          'rounded-sm py-1 pr-2 transition-colors',
          primaryAction ? 'cursor-pointer' : 'cursor-default',
          isSelected
            ? 'bg-orange-500/10 ring-1 ring-inset ring-orange-500/40'
            : isFocused
              ? 'bg-muted/60'
              : 'hover:bg-muted/40'
        )}
      >
        {/* Name — indent lives here so every following column stays aligned. */}
        <span className="flex min-w-0 items-center gap-1.5" style={{ paddingLeft: depth * 14 + 8 }}>
          {node.expandable ? (
            <span className="flex h-4 w-4 shrink-0 items-center justify-center text-muted-foreground">
              {isExpanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
            </span>
          ) : (
            <span className="h-4 w-4 shrink-0" aria-hidden="true" />
          )}
          <span
            className={cn(
              'truncate font-mono text-xs',
              node.label === '[]' ? 'text-cyan-600 dark:text-cyan-400' : 'text-foreground'
            )}
            title={node.label}
          >
            {node.label === '[]' ? '[ ]' : node.label}
          </span>
        </span>

        {/* Type */}
        <span className="flex items-center gap-1 overflow-hidden">
          {node.types.map((type) => (
            <span
              key={type}
              className={cn(
                'rounded-sm border px-1 py-px font-mono text-[9px] uppercase tracking-[0.06em]',
                typeBadgeStyles[type]
              )}
            >
              {typeAbbrev[type]}
            </span>
          ))}
        </span>

        {/* Example */}
        <span className="truncate font-mono text-[11px] text-muted-foreground" title={example ?? undefined}>
          {exampleShort}
        </span>

        {/* Presence — silent at full coverage, see `partial` above. */}
        <span
          className={cn(
            'text-right font-mono text-[10px] tabular-nums',
            partial ? 'text-amber-600 dark:text-amber-400' : 'text-transparent'
          )}
          title={`Present in ${node.seenCount} of ${node.sampleCount} sampled messages`}
        >
          {partial ? `${presencePct}%` : ''}
        </span>
      </div>

      {node.expandable &&
        isExpanded &&
        node.children.map((child) => (
          <JsonFieldTreeNode
            key={child.path}
            node={child}
            depth={depth + 1}
            expanded={expanded}
            focusedPath={focusedPath}
            selectedPath={selectedPath}
            onConfirm={onConfirm}
            onToggle={onToggle}
            onFocus={onFocus}
            onSelect={onSelect}
          />
        ))}
    </Fragment>
  )
}
