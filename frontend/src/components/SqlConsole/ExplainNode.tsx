import { useState } from 'react'
import { ChevronDown, ChevronRight, TriangleAlert } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { ExplainNode as ExplainNodeType } from '@/types/api'

interface ExplainNodeProps {
  node: ExplainNodeType
  depth?: number
  rootCost: number
  mode: 'explain' | 'analyze'
}

export function ExplainNode({ node, depth = 0, rootCost, mode }: ExplainNodeProps) {
  const [expanded, setExpanded] = useState(depth < 2)
  const hasChildren = (node.children?.length ?? 0) > 0
  const heavyNode = rootCost > 0 && node.total_cost / rootCost >= 0.5
  const seqScanWarning = /seq scan/i.test(node.node_type) && node.plan_rows >= 10000
  const showExecutionStats = mode === 'analyze'

  return (
    <div className="space-y-2">
      <div
        className={cn(
          'rounded-sm border px-3 py-2',
          node.is_bottleneck
            ? 'border-red-500/50 bg-red-500/10'
            : heavyNode
              ? 'border-amber-500/40 bg-amber-500/10'
              : 'border-border bg-background/80'
        )}
        style={{ marginLeft: `${depth * 24}px` }}
      >
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            className={cn('rounded p-0.5 text-muted-foreground hover:bg-muted', !hasChildren && 'invisible')}
            onClick={() => setExpanded((value) => !value)}
          >
            {expanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
          </button>
          <span className="font-mono text-sm text-foreground">{node.node_type}</span>
          {node.relation_name && (
            <span className="rounded-sm bg-muted/40 px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">
              {node.relation_name}
            </span>
          )}
          {seqScanWarning && (
            <span className="inline-flex items-center gap-1 rounded-sm border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 font-mono text-[11px] text-amber-700 dark:text-amber-300">
              <TriangleAlert className="h-3 w-3" />
              Seq Scan
            </span>
          )}
        </div>
        <div className="mt-2 flex flex-wrap gap-2 text-[11px] text-muted-foreground">
          <span>Cost {node.total_cost.toFixed(2)}</span>
          <span>Plan Rows {node.plan_rows}</span>
          {showExecutionStats && (
            <>
              <span>Actual {node.actual_time_ms.toFixed(2)} ms</span>
              <span>Actual Rows {node.actual_rows}</span>
              <span>Hit {node.shared_hit_blocks}</span>
              <span>Read {node.shared_read_blocks}</span>
            </>
          )}
        </div>
      </div>
      {expanded &&
        node.children?.map((child, index) => (
          <ExplainNode
            key={`${child.node_type}-${child.relation_name ?? 'child'}-${index}`}
            node={child}
            depth={depth + 1}
            rootCost={rootCost}
            mode={mode}
          />
        ))}
    </div>
  )
}
