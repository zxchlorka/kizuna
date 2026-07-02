import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { CornerDownLeft, Eraser, Loader2, TerminalSquare } from 'lucide-react'
import { DangerousCommandDialog } from '@/components/redis/RedisCli/DangerousCommandDialog'
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

const DANGEROUS_COMMANDS = new Set(['KEYS', 'FLUSHALL', 'FLUSHDB', 'DEBUG', 'SAVE', 'SHUTDOWN'])

function findDangerousCommand(input: string): string | null {
  for (const line of input.split('\n')) {
    const token = line.trim().split(/\s+/, 1)[0]?.toUpperCase()
    if (token && DANGEROUS_COMMANDS.has(token)) {
      return token
    }
  }
  return null
}

export function RedisCli({ tabId, connId }: RedisCliProps) {
  const inputRef = useRef<RedisCliInputHandle | null>(null)
  const [helperItem, setHelperItem] = useState<CompletionItem | null>(null)
  const [pendingDanger, setPendingDanger] = useState<{ command: string; statement: string } | null>(null)
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

  const handleRun = useCallback(
    (input: string) => {
      const dangerous = findDangerousCommand(input)
      if (dangerous) {
        setPendingDanger({ command: dangerous, statement: input })
        return
      }
      void runInput(connId, tabId, input)
    },
    [connId, runInput, tabId]
  )

  if (!tab) {
    return (
      <div className="flex flex-1 items-center justify-center bg-background font-mono text-sm text-muted-foreground">
        Preparing Redis CLI…
      </div>
    )
  }

  return (
    // `dark` forces the console to use the app's own dark palette (near-black +
    // amber) regardless of the app theme — a terminal reads best dark, and this
    // keeps it cohesive instead of a clashing gray block.
    <div className="dark relative flex h-full flex-1 flex-col overflow-hidden bg-background text-foreground">
      {/* Subtle amber glow anchoring the console to the app's accent identity */}
      <div className="pointer-events-none absolute inset-x-0 top-0 h-32 bg-[radial-gradient(ellipse_70%_100%_at_50%_0%,hsl(var(--accent)/0.06),transparent)]" />

      <div className="relative z-10 flex flex-wrap items-center justify-between gap-3 border-b border-border bg-card/40 px-4 py-2.5 backdrop-blur-sm">
        <div className="flex items-center gap-2.5">
          <div className="flex h-8 w-8 items-center justify-center rounded-md border border-accent/25 bg-accent/10">
            <TerminalSquare className="h-4 w-4 text-accent" />
          </div>
          <div>
            <div className="font-mono text-xs font-semibold tracking-wide text-foreground">Redis CLI</div>
            <div className="font-mono text-[11px] text-muted-foreground">{connectionLabel}</div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {tab.running ? (
            <div className="flex items-center gap-1.5 rounded-full border border-accent/25 bg-accent/5 px-2.5 py-1 font-mono text-[10px] uppercase tracking-[0.12em] text-accent">
              <Loader2 className="h-3 w-3 animate-spin" />
              Running
            </div>
          ) : null}
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="h-7 gap-1.5 px-2 font-mono text-[11px] text-muted-foreground hover:text-foreground"
            onClick={() => clearOutput(tabId)}
          >
            <Eraser className="h-3.5 w-3.5" />
            Clear
          </Button>
        </div>
      </div>

      <RedisCliOutput connId={connId} entries={tab.entries} />

      <div className="relative z-10 space-y-2.5 border-t border-border bg-card/40 px-4 py-3 backdrop-blur-sm">
        <RedisCommandHelper item={helperItem} />
        <div className="group flex items-stretch gap-2 rounded-md border border-border bg-background/80 pl-3 transition-colors focus-within:border-accent/60 focus-within:shadow-[0_0_0_3px_hsl(var(--accent)/0.12)]">
          <div className="flex select-none items-center pt-3 font-mono text-sm font-semibold text-accent">redis&gt;</div>
          <div className="flex-1 py-0.5">
            <RedisCliInput
              ref={inputRef}
              connId={connId}
              value={tab.editorValue}
              onChange={(value) => setEditorValue(tabId, value)}
              onRun={() => handleRun(tab.editorValue)}
              onClear={() => clearOutput(tabId)}
              onHistoryNavigate={(direction) => void navigateHistory(connId, tabId, direction)}
            />
          </div>
          <div className="flex items-center pr-1.5">
            <Button
              type="button"
              size="sm"
              className="h-8 gap-1.5 bg-accent font-mono text-[11px] font-semibold text-accent-foreground hover:bg-accent/90"
              disabled={tab.running}
              onClick={() => handleRun(tab.editorValue)}
            >
              <CornerDownLeft className="h-3.5 w-3.5" />
              Run
            </Button>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-0.5 font-mono text-[10px] text-muted-foreground">
          <span className="flex items-center gap-1">
            <kbd className="rounded border border-border bg-muted/40 px-1 py-px text-[9px]">Enter</kbd>
            run
          </span>
          <span className="flex items-center gap-1">
            <kbd className="rounded border border-border bg-muted/40 px-1 py-px text-[9px]">Shift+Enter</kbd>
            pipeline
          </span>
          <span className="flex items-center gap-1">
            <kbd className="rounded border border-border bg-muted/40 px-1 py-px text-[9px]">↑↓</kbd>
            history
          </span>
          <span className="flex items-center gap-1">
            <kbd className="rounded border border-border bg-muted/40 px-1 py-px text-[9px]">Ctrl+L</kbd>
            clear
          </span>
        </div>
      </div>

      <DangerousCommandDialog
        open={pendingDanger !== null}
        command={pendingDanger?.command ?? ''}
        statement={pendingDanger?.statement ?? ''}
        onOpenChange={(open) => {
          if (!open) {
            setPendingDanger(null)
          }
        }}
        onConfirm={() => {
          if (pendingDanger) {
            void runInput(connId, tabId, pendingDanger.statement)
          }
          setPendingDanger(null)
        }}
      />
    </div>
  )
}
