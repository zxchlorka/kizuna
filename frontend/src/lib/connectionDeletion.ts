import { useConnectionStore } from '@/stores/connections'
import { useLinksStore } from '@/stores/links'
import { useWorkspaceStore } from '@/stores/workspace'

/**
 * Deletes a connection and forgets everything that referenced it.
 *
 * The backend removes the connection and cascades its cross-source links in one
 * config mutation; this mirrors that locally so the UI does not need a reload:
 * links disappear from Settings immediately, and no tab is left holding the dead
 * connection id (which used to surface as `connection "..." not found` 404s).
 *
 * Orchestrated here rather than inside a store on purpose: workspace.ts already
 * imports connections.ts, so putting this in either store would create a cyclic
 * import between them.
 *
 * Local cleanup runs only after the API confirms the delete — a failed request
 * must leave the workspace exactly as it was.
 */
export async function deleteConnectionEverywhere(id: string): Promise<void> {
  await useConnectionStore.getState().remove(id)
  useLinksStore.getState().removeForConnection(id)
  useWorkspaceStore.getState().purgeConnection(id)
}
