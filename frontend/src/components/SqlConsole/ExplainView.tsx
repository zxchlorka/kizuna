import type { ExplainResult } from '@/types/api'
import { ExplainNode } from '@/components/SqlConsole/ExplainNode'

interface ExplainViewProps {
  result: ExplainResult
}

export function ExplainView({ result }: ExplainViewProps) {
  return (
    <div className="h-full overflow-auto p-3">
      <ExplainNode node={result.plan} rootCost={result.plan.total_cost || 1} mode={result.mode} />
    </div>
  )
}
