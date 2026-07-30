import { useSqlConsoleStore } from '@/stores/sqlConsole'
import { useWorkspaceStore, type WorkspaceTab } from '@/stores/workspace'

/**
 * Persists "what was I looking at": open tabs of all three kinds, the SQL
 * draft typed into each sql tab, which tab/connection is active, and which
 * connections have a chip open. Deliberately NOT persisted: query results,
 * history, table contents -- those can go stale, and showing yesterday's rows
 * as if they were current is worse than an empty pane (user's call, see the
 * task brief).
 *
 * Storage is localStorage, not the backend config: this is per-browser UI
 * state, not something that belongs in config.json (see connectionHealth.ts
 * for the established pattern this mirrors).
 *
 * Orchestrated in its own module rather than inside workspace.ts or
 * sqlConsole.ts, for the same reason connectionDeletion.ts is standalone: a
 * snapshot needs both stores' state, and having either store import the other
 * risks a cycle once both know about each other.
 */

const STORAGE_KEY = 'kizuna-workspace'
// Bump whenever the persisted shape changes incompatibly. A version mismatch
// (or missing/corrupt JSON) is treated as "nothing to restore" -- silent
// fallback to the default empty workspace, never a crash or a white screen.
const SCHEMA_VERSION = 1

interface PersistedWorkspaceV1 {
  version: typeof SCHEMA_VERSION
  tabs: WorkspaceTab[]
  activeTabId: string | null
  activeTabByConnection: Record<string, string>
  openConnectionIds: string[]
  // tabId -> SQL editor text, sql-kind tabs only.
  sqlDrafts: Record<string, string>
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return isPlainObject(value) && Object.values(value).every((item) => typeof item === 'string')
}

// Structural check of one tab against the WorkspaceTab union. Only the fields
// that get dereferenced during hydration are checked -- an unknown objectType
// string renders as an unsupported view, it does not crash.
function isWorkspaceTab(value: unknown): value is WorkspaceTab {
  if (!isPlainObject(value)) return false
  if (typeof value.id !== 'string' || typeof value.connId !== 'string' || typeof value.label !== 'string') {
    return false
  }
  if (value.anchorConnId !== undefined && typeof value.anchorConnId !== 'string') {
    return false
  }
  switch (value.kind) {
    case 'sql':
    case 'redis-cli':
      return true
    case 'object':
      return typeof value.object === 'string' && typeof value.objectType === 'string'
    default:
      return false
  }
}

// The snapshot comes back from localStorage, which nothing guarantees we wrote:
// a half-finished write, a hand edit, or another build under the same key all
// land here. Validating only `Array.isArray(tabs)` let `tabs: [null]` through,
// and the first tabPageId(tab) then threw on tab.anchorConnId. That crash is
// self-perpetuating -- the bad snapshot stays in storage, so every reload
// crashes again until the user clears site data by hand.
//
// A malformed snapshot is rejected whole rather than filtered: dropping just the
// bad tabs would leave activeTabId and activeTabByConnection pointing at tabs
// that no longer exist, trading one inconsistent state for another.
function isPersistedWorkspace(value: unknown): value is PersistedWorkspaceV1 {
  if (!isPlainObject(value)) return false
  return (
    value.version === SCHEMA_VERSION &&
    Array.isArray(value.tabs) &&
    value.tabs.every(isWorkspaceTab) &&
    (value.activeTabId === null || typeof value.activeTabId === 'string') &&
    isStringRecord(value.activeTabByConnection) &&
    isStringArray(value.openConnectionIds) &&
    isStringRecord(value.sqlDrafts)
  )
}

function loadPersisted(): PersistedWorkspaceV1 | null {
  if (typeof window === 'undefined') {
    return null
  }
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) {
      return null
    }
    const parsed: unknown = JSON.parse(raw)
    return isPersistedWorkspace(parsed) ? parsed : null
  } catch {
    return null
  }
}

function buildSnapshot(): PersistedWorkspaceV1 {
  const workspace = useWorkspaceStore.getState()
  const sqlConsole = useSqlConsoleStore.getState()

  const sqlDrafts: Record<string, string> = {}
  workspace.tabs.forEach((tab) => {
    if (tab.kind === 'sql') {
      sqlDrafts[tab.id] = sqlConsole.tabs[tab.id]?.editorValue ?? ''
    }
  })

  return {
    version: SCHEMA_VERSION,
    tabs: workspace.tabs,
    activeTabId: workspace.activeTabId,
    activeTabByConnection: workspace.activeTabByConnection,
    openConnectionIds: workspace.openConnectionIds,
    sqlDrafts,
  }
}

function persistNow(): void {
  if (typeof window === 'undefined') {
    return
  }
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(buildSnapshot()))
  } catch {
    // Best-effort: a full or unavailable localStorage (private browsing, quota
    // exceeded) must not break the app. Restoring across reloads is a
    // convenience, not a guarantee.
  }
}

// The SQL editor fires a change on every keystroke; writing to localStorage
// that often is wasted work (and, for a large draft, can visibly jank typing).
// 500ms comfortably absorbs a keystroke burst -- typing pauses (reading the
// last result, thinking about the next line) are typically longer than that --
// while capping the worst case (reload landing mid-burst) at losing half a
// second of text. The visibilitychange flush below closes that last gap.
const PERSIST_DEBOUNCE_MS = 500
let pendingPersist: ReturnType<typeof setTimeout> | undefined

function schedulePersist(): void {
  if (pendingPersist !== undefined) {
    clearTimeout(pendingPersist)
  }
  pendingPersist = setTimeout(() => {
    pendingPersist = undefined
    persistNow()
  }, PERSIST_DEBOUNCE_MS)
}

function flushPersist(): void {
  if (pendingPersist !== undefined) {
    clearTimeout(pendingPersist)
    pendingPersist = undefined
  }
  persistNow()
}

let wired = false

/**
 * Call once at app startup, before the workspace is first rendered. Restores
 * the previous session's tabs and SQL drafts synchronously (so there is no
 * "tabs appear a moment after the empty state" flash), and wires up debounced
 * persistence for subsequent changes.
 *
 * Restoration here is deliberately UNFILTERED: it does not check that a tab's
 * connection still exists, because the connection list has not loaded yet at
 * this point (calling this any later would reintroduce the flash; calling the
 * connection-list fetch first would delay first paint waiting on the network).
 * Call pruneDeadConnections once the connection list is available to drop
 * anything stale -- see App.tsx.
 */
export function restoreWorkspace(): void {
  const persisted = loadPersisted()
  if (persisted) {
    useWorkspaceStore.setState({
      tabs: persisted.tabs,
      activeTabId: persisted.activeTabId,
      activeTabByConnection: persisted.activeTabByConnection,
      openConnectionIds: persisted.openConnectionIds,
    })
    useSqlConsoleStore.getState().restoreEditorValues(persisted.sqlDrafts)
  }

  if (wired) {
    return
  }
  wired = true

  useWorkspaceStore.subscribe((state, prev) => {
    if (
      state.tabs !== prev.tabs ||
      state.activeTabId !== prev.activeTabId ||
      state.activeTabByConnection !== prev.activeTabByConnection ||
      state.openConnectionIds !== prev.openConnectionIds
    ) {
      schedulePersist()
    }
  })

  // sqlConsole's `tabs` record also changes for reasons unrelated to
  // editorValue (running state, results, history panel...); those extra
  // triggers just re-persist the same editorValue values, which is harmless
  // and still debounced -- not worth a field-level diff to avoid.
  useSqlConsoleStore.subscribe((state, prev) => {
    if (state.tabs !== prev.tabs) {
      schedulePersist()
    }
  })

  // visibilitychange (not beforeunload/unload) is the reload/close-safe flush
  // point: it fires reliably on tab close, reload and navigation, doesn't
  // block the back-forward cache the way unload handlers can, and works on
  // mobile Safari where beforeunload is unreliable.
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') {
        flushPersist()
      }
    })
  }
}

/**
 * Drops any restored tab whose connection no longer exists -- deleted since
 * the tab was last open, or restored from a different browser/config that
 * doesn't have it. Must only be called once the connection list has actually
 * loaded: calling it with an empty-because-not-fetched-yet list would wrongly
 * discard every restored tab.
 */
export function pruneDeadConnections(liveConnIds: string[]): void {
  useWorkspaceStore.getState().pruneMissingConnections(liveConnIds)
}

/**
 * Guarded entry point for the prune. The policy lives here rather than in the
 * caller because pruning is destructive *and* immediately persisted: a wrong
 * prune drops the restored tabs and overwrites the saved snapshot with the
 * empty result, leaving nothing to recover from. Both refusals below cost a
 * stale tab at worst; getting them wrong costs the session.
 *
 * - `error`: the connection store sets loadedOnce even when the fetch fails,
 *   leaving connections at its initial []. One unreachable backend on reload —
 *   a restarting container, a request that outran its timeout — would otherwise
 *   wipe everything.
 * - empty list: the only way it is genuinely empty is that every connection was
 *   deleted, and each deletion already purges its own tabs via purgeConnection.
 *   No legitimate case needs a bulk prune to zero.
 */
export function syncWorkspaceWithConnections(input: {
  loadedOnce: boolean
  error: string | null
  connIds: string[]
}): void {
  if (!input.loadedOnce || input.error || input.connIds.length === 0) {
    return
  }
  pruneDeadConnections(input.connIds)
}
