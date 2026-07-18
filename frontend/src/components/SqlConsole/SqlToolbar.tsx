import { AlertTriangle, FileCode2, History, Play, Sparkles } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { DatabaseSwitcher } from '@/components/SqlConsole/DatabaseSwitcher'

interface SqlToolbarProps {
  running: boolean
  connId: string
  tabId: string
  connectionLabel: string
  onRun: () => void
  onExplain: () => void
  onAnalyze: () => void
  onFormat: () => void
  onToggleHistory: () => void
}

export function SqlToolbar({
  running,
  connId,
  tabId,
  connectionLabel,
  onRun,
  onExplain,
  onAnalyze,
  onFormat,
  onToggleHistory,
}: SqlToolbarProps) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border bg-background/95 px-3 py-2">
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" size="sm" className="h-8 gap-1.5 font-mono text-[11px]" onClick={onRun} disabled={running}>
          <Play className="h-3.5 w-3.5" />
          Run
        </Button>
        <Button type="button" size="sm" variant="outline" className="h-8 gap-1.5 font-mono text-[11px]" onClick={onExplain} disabled={running}>
          <Sparkles className="h-3.5 w-3.5" />
          Explain
        </Button>
        <Button type="button" size="sm" variant="outline" className="h-8 gap-1.5 font-mono text-[11px]" onClick={onAnalyze} disabled={running}>
          <AlertTriangle className="h-3.5 w-3.5" />
          Analyze
        </Button>
        <Button type="button" size="sm" variant="ghost" className="h-8 gap-1.5 font-mono text-[11px]" onClick={onFormat} disabled={running}>
          <FileCode2 className="h-3.5 w-3.5" />
          Format
        </Button>
        <Button type="button" size="sm" variant="ghost" className="h-8 gap-1.5 font-mono text-[11px]" onClick={onToggleHistory}>
          <History className="h-3.5 w-3.5" />
          History
        </Button>
      </div>
      <DatabaseSwitcher key={connId} connId={connId} tabId={tabId} connectionLabel={connectionLabel} />
    </div>
  )
}
