import { useEffect, useState } from 'react'
import { ArrowUpRight, Copy, KeyRound, RefreshCw, Table2, Trash2, Zap } from 'lucide-react'
import { DropConfirmDialog } from '@/components/DDL/DropConfirmDialog'
import { EmptyState } from '@/components/EmptyState'
import { ErrorBanner } from '@/components/ErrorBanner'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { useDataStore } from '@/stores/data'
import { useToastStore } from '@/stores/toast'
import { useWorkspaceStore } from '@/stores/workspace'

interface IndexInspectorViewProps {
  connId: string
  object: string
  tabId: string
}

function formatObjectLabel(object: string): string {
  return object.includes('.') ? object.split('.', 2)[1] : object
}

export function IndexInspectorView({ connId, object, tabId }: IndexInspectorViewProps) {
  const tabData = useDataStore((state) => state.tabs[tabId])
  const fetchObjectInfo = useDataStore((state) => state.fetchObjectInfo)
  const ddl = useDataStore((state) => state.ddl)
  const refreshTree = useWorkspaceStore((state) => state.refreshTree)
  const openTab = useWorkspaceStore((state) => state.openTab)
  const closeTab = useWorkspaceStore((state) => state.closeTab)
  const pushToast = useToastStore((state) => state.push)

  const [showDropDialog, setShowDropDialog] = useState(false)
  const [localError, setLocalError] = useState<string | null>(null)
  const [isDropping, setIsDropping] = useState(false)

  useEffect(() => {
    void fetchObjectInfo(connId, object, tabId)
    setShowDropDialog(false)
    setLocalError(null)
  }, [connId, fetchObjectInfo, object, tabId])

  const info = tabData?.objectInfo ?? null
  const isLoading = tabData?.objectInfoLoading ?? false
  const error = localError ?? tabData?.error ?? null

  const handleRefresh = () => {
    setLocalError(null)
    void fetchObjectInfo(connId, object, tabId)
  }

  const handleJumpToTable = () => {
    if (!info?.owner_table) {
      setLocalError('Owner table is missing for this index.')
      return
    }
    openTab(connId, `${info.schema}.${info.owner_table}`, 'table')
  }

  const handleCopyDefinition = async () => {
    if (!info?.definition) return
    try {
      await navigator.clipboard.writeText(info.definition)
      pushToast({
        tone: 'success',
        title: 'Definition copied',
        message: `${formatObjectLabel(object)} SQL definition copied to clipboard.`,
      })
    } catch (copyError) {
      setLocalError((copyError as Error).message)
    }
  }

  const handleDropIndex = async () => {
    if (!info) return

    setIsDropping(true)
    setLocalError(null)
    try {
      await ddl(connId, {
        type: 'drop_index',
        schema: info.schema,
        object: info.name,
        params: {},
      })
      await refreshTree(connId)
      closeTab(tabId)
      pushToast({
        tone: 'success',
        title: 'Index dropped',
        message: `${info.schema}.${info.name} was removed.`,
      })
    } catch (dropError) {
      const message = (dropError as Error).message
      setLocalError(message)
      pushToast({ tone: 'error', title: 'Drop index failed', message })
      throw dropError
    } finally {
      setIsDropping(false)
      setShowDropDialog(false)
    }
  }

  if (isLoading && !info) {
    return (
      <div className="flex flex-1 flex-col gap-4 overflow-auto p-4">
        <div className="rounded-sm border border-border bg-card p-4">
          <div className="flex items-start justify-between gap-4">
            <div className="flex min-w-0 flex-1 items-start gap-3">
              <Skeleton className="h-10 w-10 rounded-sm" />
              <div className="min-w-0 flex-1 space-y-2">
                <Skeleton className="h-5 w-52" />
                <Skeleton className="h-4 w-40" />
              </div>
            </div>
            <div className="flex gap-2">
              <Skeleton className="h-8 w-28" />
              <Skeleton className="h-8 w-24" />
            </div>
          </div>
          <div className="mt-4 grid gap-3 md:grid-cols-3">
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-16 w-full" />
          </div>
        </div>
        <div className="grid gap-4 lg:grid-cols-[0.9fr_1.1fr]">
          <Skeleton className="h-64 w-full" />
          <Skeleton className="h-64 w-full" />
        </div>
      </div>
    )
  }

  if (error && !info) {
    return (
      <div className="flex flex-1 items-center justify-center p-6">
        <div className="w-full max-w-xl space-y-4">
          <ErrorBanner message={error} onRetry={handleRefresh} />
          <EmptyState
            variant="no_data"
            title="Unable to load index"
            description="The selected index metadata could not be loaded. Retry once the connection and database are available."
          />
        </div>
      </div>
    )
  }

  if (!info) {
    return (
      <div className="flex flex-1 items-center justify-center p-6">
        <div className="w-full max-w-md">
          <EmptyState
            variant="no_data"
            title="Index not available"
            description="The selected index is no longer available in this schema."
          />
        </div>
      </div>
    )
  }

  const ownerObject = info.owner_table ? `${info.schema}.${info.owner_table}` : ''

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      {error && (
        <div className="mx-3 mt-3">
          <ErrorBanner message={error} onDismiss={() => setLocalError(null)} />
        </div>
      )}

      <div className="flex flex-1 flex-col overflow-auto p-4">
        <div className="rounded-sm border border-border bg-card">
          <div className="border-b border-border px-4 py-4">
            <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
              <div className="min-w-0 space-y-3">
                <div className="flex items-start gap-3">
                  <div className="mt-0.5 flex h-10 w-10 items-center justify-center rounded-sm border border-yellow-500/25 bg-yellow-500/10 text-yellow-500">
                    <Zap className="h-4 w-4" />
                  </div>
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <h2 className="truncate font-mono text-lg font-semibold text-foreground">{info.name}</h2>
                      <span className="inline-flex items-center rounded border border-border bg-muted px-2 py-0.5 text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
                        {info.method || 'index'}
                      </span>
                      {info.is_unique && (
                        <span className="inline-flex items-center rounded border border-emerald-500/25 bg-emerald-500/10 px-2 py-0.5 text-[10px] uppercase tracking-[0.14em] text-emerald-500">
                          <KeyRound className="mr-1 h-3 w-3" />
                          unique
                        </span>
                      )}
                    </div>
                    <p className="mt-1 text-sm text-muted-foreground">
                      Schema <span className="font-mono text-foreground">{info.schema}</span>
                    </p>
                  </div>
                </div>

                <div className="grid gap-3 md:grid-cols-3">
                  <div className="rounded-sm border border-border bg-muted/10 px-3 py-3">
                    <div className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground">Owner table</div>
                    <div className="mt-2 flex items-center gap-2 font-mono text-sm text-foreground">
                      <Table2 className="h-3.5 w-3.5 text-blue-500" />
                      <span>{info.owner_table || 'unknown'}</span>
                    </div>
                  </div>
                  <div className="rounded-sm border border-border bg-muted/10 px-3 py-3">
                    <div className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground">Columns</div>
                    <div className="mt-2 font-mono text-sm text-foreground">{info.columns.length}</div>
                  </div>
                  <div className="rounded-sm border border-border bg-muted/10 px-3 py-3">
                    <div className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground">Object type</div>
                    <div className="mt-2 font-mono text-sm text-foreground">{info.object_type}</div>
                  </div>
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <Button variant="outline" size="sm" className="h-8 gap-1.5 px-3" onClick={handleRefresh} disabled={isLoading || isDropping}>
                  <RefreshCw className={`h-3.5 w-3.5 ${isLoading ? 'animate-spin' : ''}`} />
                  Refresh
                </Button>
                <Button variant="outline" size="sm" className="h-8 gap-1.5 px-3" onClick={handleJumpToTable} disabled={!ownerObject || isDropping}>
                  <ArrowUpRight className="h-3.5 w-3.5" />
                  Jump to table
                </Button>
                <Button variant="destructive" size="sm" className="h-8 gap-1.5 px-3" onClick={() => setShowDropDialog(true)} disabled={isDropping}>
                  <Trash2 className="h-3.5 w-3.5" />
                  Drop index
                </Button>
              </div>
            </div>
          </div>

          <div className="grid gap-4 p-4 xl:grid-cols-[0.9fr_1.1fr]">
            <section className="space-y-4">
              <div className="rounded-sm border border-border bg-muted/10">
                <div className="border-b border-border px-3 py-2 text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
                  Indexed columns
                </div>
                <div className="space-y-2 p-3">
                  {info.columns.length > 0 ? (
                    info.columns.map((column, index) => (
                      <div key={`${column}-${index}`} className="flex items-center gap-3 rounded-sm border border-border bg-background px-3 py-2">
                        <div className="flex h-5 w-5 items-center justify-center rounded-sm bg-muted text-[10px] font-medium text-muted-foreground">
                          {index + 1}
                        </div>
                        <span className="font-mono text-sm text-foreground">{column}</span>
                      </div>
                    ))
                  ) : (
                    <div className="rounded-sm border border-dashed border-border px-3 py-4 text-sm text-muted-foreground">
                      This index uses expressions or metadata that cannot be mapped cleanly to named columns. Use the SQL definition as the source of truth.
                    </div>
                  )}
                </div>
              </div>

              {info.predicate && (
                <section className="rounded-sm border border-border bg-muted/10">
                  <div className="border-b border-border px-3 py-2 text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
                    Condition
                  </div>
                  <div className="p-3">
                    <pre className="overflow-x-auto whitespace-pre-wrap break-words rounded-sm border border-border bg-background px-3 py-3 font-mono text-xs text-foreground">
                      {info.predicate}
                    </pre>
                  </div>
                </section>
              )}
            </section>

            <section className="rounded-sm border border-border bg-muted/10">
              <div className="flex items-center justify-between border-b border-border px-3 py-2">
                <div className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground">SQL definition</div>
                <Button variant="ghost" size="sm" className="h-7 gap-1.5 px-2 text-[11px]" onClick={handleCopyDefinition}>
                  <Copy className="h-3.5 w-3.5" />
                  Copy
                </Button>
              </div>
              <div className="p-3">
                <pre className="min-h-[320px] overflow-x-auto whitespace-pre-wrap break-words rounded-sm border border-border bg-background px-3 py-3 font-mono text-xs leading-6 text-foreground">
                  {info.definition}
                </pre>
              </div>
            </section>
          </div>
        </div>
      </div>

      <DropConfirmDialog
        open={showDropDialog}
        title="Drop Index"
        description={`Delete ${info.schema}.${info.name} from the database.`}
        targetLabel="index"
        expectedValue={info.name}
        saving={isDropping}
        onOpenChange={setShowDropDialog}
        onConfirm={handleDropIndex}
      />
    </div>
  )
}
