import { useState } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { RedisResultTable } from '@/components/redis/RedisCli/RedisResultTable'
import type { ExecResult } from '@/types/api'

interface RedisResultFormatterProps {
  result: ExecResult
}

function renderValue(value: unknown, prettyJson: boolean) {
  if (value === null || value === undefined) {
    return '(nil)'
  }
  if (typeof value === 'string') {
    if (!prettyJson) {
      return value
    }
    try {
      return JSON.stringify(JSON.parse(value), null, 2)
    } catch {
      return value
    }
  }
  if (typeof value === 'object') {
    return JSON.stringify(value, null, 2)
  }
  return String(value)
}

export function RedisResultFormatter({ result }: RedisResultFormatterProps) {
  const [prettyJson, setPrettyJson] = useState(true)
  const isJson = result.column_types?.[0] === 'json'

  if (result.error) {
    return <div className="font-mono text-sm text-destructive">(error) {result.error}</div>
  }

  // Any reply with two or more columns (hash field/value, zset member/score,
  // list index/value, …) renders as one labelled, expandable table.
  if (result.columns.length >= 2) {
    return <RedisResultTable result={result} />
  }

  const scalar = result.rows[0]?.[0]
  if (result.column_types?.[0] === 'nil' || scalar === null || scalar === undefined) {
    return <div className="font-mono text-sm text-muted-foreground">(nil)</div>
  }
  if (typeof scalar === 'number') {
    return <div className="font-mono text-sm text-amber-600 dark:text-amber-400">(integer) {scalar}</div>
  }

  return (
    <div className="space-y-2">
      {isJson ? (
        <Button type="button" size="sm" variant="ghost" className="h-6 gap-1 px-1 font-mono text-[10px]" onClick={() => setPrettyJson((current) => !current)}>
          {prettyJson ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
          {prettyJson ? 'Formatted JSON' : 'Raw JSON'}
        </Button>
      ) : null}
      <pre className="overflow-x-auto whitespace-pre-wrap rounded-sm border border-border/70 bg-background/60 px-3 py-2 font-mono text-sm text-emerald-600 dark:text-emerald-300">
        {renderValue(scalar, prettyJson)}
      </pre>
    </div>
  )
}
