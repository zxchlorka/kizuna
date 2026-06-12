import { useEffect, useMemo, useRef, useState } from 'react'
import { Loader2, TerminalSquare } from 'lucide-react'
import { RedisCliInput, type RedisCliInputHandle } from '@/components/redis/RedisCli/RedisCliInput'
import { RedisCliOutput } from '@/components/redis/RedisCli/RedisCliOutput'
import { RedisCommandHelper } from '@/components/redis/RedisCli/RedisCommandHelper'
import { Button } from '@/components/ui/button'
import { useAutocomplete } from '@/hooks/useAutocomplete'
import { useConnectionStore } from '@/stores/connections'
import { useRedisCliStore } from '@/stores/redisCli'
import type { CompletionItem } from '@/types/api'

interface RedisCliProps {
  tabId: string
  connId: string
}

export function RedisCli({ tabId, connId }: RedisCliProps) {
  const inputRef = useRef<RedisCliInputHandle | null>(null)
  const [helperItem, setHelperItem] = useState<CompletionItem | null>(null)
  const requestCompletions = useAutocomplete(connId)
  const connections = useConnectionStore((state) => state.connections)
  const fetchConnections = useConnectionStore((state) => state.fetch)
  const tab = useRedisCliStore((state) => state.tabs[tabId])
  const ensureTab = useRedisCliStore((state) => state.ensureTab)
  const setEditorValue = useRedisCliStore((state) => state.setEditorValue)
  const clearOutput = useRedisCliStore((state) => state.clearOutput)
  const navigateHistory = useRedisCliStore((state) => state.navigateHistory)
  const runInput = useRedisCliStore((state) => state.runInput)

  useEffect(() => {
    ensureTab(tabId)
  }, [ensureTab, tabId])

  useEffect(() => {
    if (connections.length === 0) {
      void fetchConnections()
    }
  }, [connections.length, fetchConnections])

  useEffect(() => {
    if (!tab) {
      return
    }
    const firstToken = tab.editorValue.trim().split(/\s+/, 1)[0] ?? ''
    if (!firstToken) {
      setHelperItem(null)
      return
    }
    const timer = window.setTimeout(() => {
      void requestCompletions({ prefix: firstToken, context: 'command' }).then((items) => {
        setHelperItem(items[0] ?? null)
      }).catch(() => {
        setHelperItem(null)
      })
    }, 120)
    return () => window.clearTimeout(timer)
  }, [requestCompletions, tab])

  const connectionLabel = useMemo(() => {
    const connection = connections.find((item) => item.id === connId)
    return connection ? `${connection.name} · Redis` : connId
  }, [connections, connId])

  if (!tab) {
    return (
      <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
        Preparing Redis CLI…
      </div>
    )
  }

  return (
    <div className="flex h-full flex-1 flex-col overflow-hidden bg-[linear-gradient(180deg,rgba(2,6,23,0.96),rgba(15,23,42,0.92))] text-slate-100">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800 px-4 py-3">
        <div>
          <div className="flex items-center gap-2 font-mono text-sm text-slate-100">
            <TerminalSquare className="h-4 w-4 text-cyan-400" />
            Redis CLI
          </div>
          <div className="mt-1 text-xs text-slate-400">{connectionLabel}</div>
        </div>
        <div className="flex items-center gap-2">
          <Button type="button" size="sm" variant="outline" className="h-8 border-slate-700 bg-slate-950/50 font-mono text-[11px] text-slate-200 hover:bg-slate-900" onClick={() => clearOutput(tabId)}>
            Clear output
          </Button>
          {tab.running ? (
            <div className="flex items-center gap-2 font-mono text-xs text-slate-400">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              Running
            </div>
          ) : null}
        </div>
      </div>

      <RedisCliOutput entries={tab.entries} />

      <div className="space-y-3 border-t border-slate-800 bg-slate-950/80 px-4 py-4">
        <RedisCommandHelper item={helperItem} />
        <div className="flex items-start gap-3">
          <div className="pt-3 font-mono text-sm text-cyan-400">redis&gt;</div>
          <div className="flex-1 space-y-2">
            <RedisCliInput
              ref={inputRef}
              connId={connId}
              value={tab.editorValue}
              onChange={(value) => setEditorValue(tabId, value)}
              onRun={() => void runInput(connId, tabId, tab.editorValue)}
              onClear={() => clearOutput(tabId)}
              onHistoryNavigate={(direction) => void navigateHistory(connId, tabId, direction)}
            />
            <div className="flex items-center justify-between gap-3 text-[11px] text-slate-400">
              <div>Enter to run, Shift+Enter for pipeline input, Ctrl+L to clear.</div>
              <Button
                type="button"
                size="sm"
                className="h-8 gap-1.5 bg-cyan-500 text-slate-950 hover:bg-cyan-400"
                disabled={tab.running}
                onClick={() => void runInput(connId, tabId, tab.editorValue)}
              >
                Run
              </Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
