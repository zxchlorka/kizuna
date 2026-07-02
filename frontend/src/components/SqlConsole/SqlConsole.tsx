import { useEffect, useMemo, useRef, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { EmptyState } from '@/components/EmptyState'
import { AnalyzeWarningDialog } from '@/components/SqlConsole/AnalyzeWarningDialog'
import { HistoryPanel } from '@/components/SqlConsole/HistoryPanel'
import { SqlEditor, type SqlEditorHandle } from '@/components/SqlConsole/SqlEditor'
import { SqlResultsArea } from '@/components/SqlConsole/SqlResultsArea'
import { SqlStatusBar } from '@/components/SqlConsole/SqlStatusBar'
import { SqlToolbar } from '@/components/SqlConsole/SqlToolbar'
import { getSqlStatements } from '@/lib/sqlStatements'
import { useConnectionStore } from '@/stores/connections'
import { useSqlConsoleStore } from '@/stores/sqlConsole'
import { useWorkspaceStore } from '@/stores/workspace'
import type { SqlCatalogTable } from '@/components/SqlConsole/SqlAutocomplete'

interface SqlConsoleProps {
  tabId: string
  connId: string
}

export function SqlConsole({ tabId, connId }: SqlConsoleProps) {
  const editorRef = useRef<SqlEditorHandle | null>(null)
  const containerRef = useRef<HTMLDivElement | null>(null)
  const [analyzeDialogOpen, setAnalyzeDialogOpen] = useState(false)
  const [pendingAnalyzeStatement, setPendingAnalyzeStatement] = useState('')
  const connections = useConnectionStore((state) => state.connections)
  const fetchConnections = useConnectionStore((state) => state.fetch)
  const treeItems = useWorkspaceStore((state) => state.treeItems)
  const tab = useSqlConsoleStore((state) => state.tabs[tabId])
  const ensureTab = useSqlConsoleStore((state) => state.ensureTab)
  const setEditorValue = useSqlConsoleStore((state) => state.setEditorValue)
  const setSplitSize = useSqlConsoleStore((state) => state.setSplitSize)
  const toggleHistory = useSqlConsoleStore((state) => state.toggleHistory)
  const setHistoryOpen = useSqlConsoleStore((state) => state.setHistoryOpen)
  const setHistorySearch = useSqlConsoleStore((state) => state.setHistorySearch)
  const setActiveResult = useSqlConsoleStore((state) => state.setActiveResult)
  const applyHistoryCommand = useSqlConsoleStore((state) => state.applyHistoryCommand)
  const navigateHistory = useSqlConsoleStore((state) => state.navigateHistory)
  const fetchHistory = useSqlConsoleStore((state) => state.fetchHistory)
  const clearHistory = useSqlConsoleStore((state) => state.clearHistory)
  const runStatements = useSqlConsoleStore((state) => state.runStatements)
  const runExplain = useSqlConsoleStore((state) => state.runExplain)
  const runAnalyze = useSqlConsoleStore((state) => state.runAnalyze)

  const catalogTables = useMemo<SqlCatalogTable[]>(() => {
    const tables: SqlCatalogTable[] = []
    for (const [schema, items] of Object.entries(treeItems)) {
      if (schema === '') {
        continue
      }
      for (const item of items) {
        if (item.type === 'table' || item.type === 'view') {
          tables.push({
            schema: item.schema,
            name: item.name,
            type: item.type,
          })
        }
      }
    }
    return tables
  }, [treeItems])

  const catalogSchemas = useMemo(
    () => Array.from(new Set(catalogTables.map((table) => table.schema))).sort((left, right) => left.localeCompare(right)),
    [catalogTables]
  )

  useEffect(() => {
    ensureTab(tabId)
  }, [ensureTab, tabId])

  useEffect(() => {
    if (connections.length === 0) {
      void fetchConnections()
    }
  }, [connections.length, fetchConnections])

  useEffect(() => {
    if (!tab?.historyOpen) {
      return
    }
    const timer = window.setTimeout(() => {
      void fetchHistory(connId, tabId, tab.historySearch)
    }, 180)
    return () => window.clearTimeout(timer)
  }, [connId, fetchHistory, tab?.historyOpen, tab?.historySearch, tabId])

  const connectionLabel = useMemo(() => {
    const connection = connections.find((item) => item.id === connId)
    if (!connection) {
      return connId
    }
    return `${connection.name} · ${connection.database}`
  }, [connections, connId])

  const activeResult = tab?.results.find((result) => result.id === tab.activeResultId) ?? tab?.results[0] ?? null

  if (!tab) {
    return (
      <div className="flex flex-1 items-center justify-center p-6">
        <EmptyState variant="no_results" title="Preparing SQL Console" description="Initializing editor state for this tab." />
      </div>
    )
  }

  const handleRun = async (overrideText?: string) => {
    const text = (overrideText ?? editorRef.current?.getSelectedTextOrCurrentStatement() ?? '').trim()
    if (!text) {
      return
    }
    const statements = getSqlStatements(text)
    if (statements.length === 0) {
      return
    }
    await runStatements(connId, tabId, statements)
  }

  const handleExplain = async () => {
    const statement = editorRef.current?.getSelectedTextOrCurrentStatement() ?? ''
    if (!statement.trim()) {
      return
    }
    await runExplain(connId, tabId, statement)
  }

  const handleAnalyze = () => {
    const statement = editorRef.current?.getSelectedTextOrCurrentStatement() ?? ''
    if (!statement.trim()) {
      return
    }
    setPendingAnalyzeStatement(statement)
    setAnalyzeDialogOpen(true)
  }

  const handleConfirmAnalyze = async () => {
    const statement = pendingAnalyzeStatement.trim()
    setAnalyzeDialogOpen(false)
    if (!statement) {
      return
    }
    await runAnalyze(connId, tabId, statement)
  }

  const handleClearHistory = async () => {
    if (!window.confirm('Clear query history for this connection?')) {
      return
    }
    await clearHistory(connId, tabId)
  }

  const handleStartResize = (event: React.MouseEvent<HTMLDivElement>) => {
    const container = containerRef.current
    if (!container) {
      return
    }
    const bounds = container.getBoundingClientRect()

    const onMove = (moveEvent: MouseEvent) => {
      const next = ((moveEvent.clientY - bounds.top) / bounds.height) * 100
      setSplitSize(tabId, next)
    }

    const onUp = () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }

    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    event.preventDefault()
  }

  return (
    <div ref={containerRef} className="relative flex h-full flex-1 flex-col overflow-hidden bg-background">
      <SqlToolbar
        running={tab.running}
        connectionLabel={connectionLabel}
        onRun={() => void handleRun()}
        onExplain={() => void handleExplain()}
        onAnalyze={handleAnalyze}
        onFormat={() => editorRef.current?.formatDocument()}
        onToggleHistory={() => toggleHistory(tabId)}
      />

      <div className="relative flex-1 overflow-hidden">
        <div style={{ height: `${tab.splitSize}%` }} className="border-b border-border bg-muted/10">
          <SqlEditor
            ref={editorRef}
            connId={connId}
            value={tab.editorValue}
            onChange={(next) => setEditorValue(tabId, next)}
            onRun={() => void handleRun()}
            onExplain={() => void handleExplain()}
            onToggleHistory={() => toggleHistory(tabId)}
            onHistoryNavigate={(direction) => void navigateHistory(connId, tabId, direction)}
            catalogTables={catalogTables}
            catalogSchemas={catalogSchemas}
          />
        </div>

        <div
          role="separator"
          aria-orientation="horizontal"
          onMouseDown={handleStartResize}
          className="flex h-3 cursor-row-resize items-center justify-center bg-background"
        >
          <div className="h-1 w-28 rounded-full bg-border/80" />
        </div>

        <div style={{ height: `calc(${100 - tab.splitSize}% - 12px)` }} className="overflow-hidden">
          {tab.running ? (
            <div className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              Running statement
            </div>
          ) : (
            <SqlResultsArea
              results={tab.results}
              activeResultId={tab.activeResultId}
              onSelectResult={(resultId) => setActiveResult(tabId, resultId)}
              connId={connId}
            />
          )}
        </div>

        <HistoryPanel
          open={tab.historyOpen}
          loading={tab.historyLoading}
          search={tab.historySearch}
          items={tab.history}
          onSearchChange={(value) => setHistorySearch(tabId, value)}
          onClose={() => setHistoryOpen(tabId, false)}
          onClear={() => void handleClearHistory()}
          onInsert={(command) => {
            applyHistoryCommand(tabId, command)
            editorRef.current?.focus()
          }}
          onExecute={(command) => {
            applyHistoryCommand(tabId, command)
            void handleRun(command)
          }}
        />

        <AnalyzeWarningDialog
          open={analyzeDialogOpen}
          statement={pendingAnalyzeStatement}
          onOpenChange={(open) => {
            setAnalyzeDialogOpen(open)
            if (!open) {
              setPendingAnalyzeStatement('')
            }
          }}
          onConfirm={() => void handleConfirmAnalyze()}
        />
      </div>

      <SqlStatusBar activeResult={activeResult} totalResults={tab.results.length} />
    </div>
  )
}
