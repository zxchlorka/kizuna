import { useSqlConsoleStore } from '@/stores/sqlConsole'
import { useWorkspaceStore, type WorkspaceTab } from '@/stores/workspace'

const sqlTargets = (tabs: WorkspaceTab[]) =>
  new Map(tabs.filter((tab) => tab.kind === 'sql').map((tab) => [tab.id, tab.connId]))

// A console tab keeps its server session while a transaction is open. Ending it
// here, on every change of the tab list, covers each way a tab goes away (the
// X, close others/all, closing the connection, purging a deleted one) and a tab
// moved to another database, without each of those paths having to remember.
export function startSqlSessionCleanup(): () => void {
  return useWorkspaceStore.subscribe((state, prev) => {
    if (state.tabs === prev.tabs) return
    const now = sqlTargets(state.tabs)
    for (const [tabId, connId] of sqlTargets(prev.tabs)) {
      if (now.get(tabId) !== connId) useSqlConsoleStore.getState().endSession(connId, tabId)
    }
  })
}

// Closing a console with a transaction open rolls it back, so the user is
// asked first. Returns whether to go ahead.
export function confirmCloseConsoles(tabIds: string[]): boolean {
  const consoles = useSqlConsoleStore.getState().tabs
  const open = tabIds.filter((id) => {
    const transaction = consoles[id]?.transaction
    return transaction === 'open' || transaction === 'failed'
  })
  if (open.length === 0) return true
  const what = open.length === 1 ? 'A console has' : `${open.length} consoles have`
  return window.confirm(`${what} an open transaction. Closing rolls it back. Close anyway?`)
}
