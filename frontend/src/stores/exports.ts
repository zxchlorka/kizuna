import { create } from 'zustand'
import { apiFetch, throwOnApiError } from '@/lib/http'
import { isActive } from '@/lib/exportProgress'

export type ExportStatus = 'starting' | 'running' | 'done' | 'failed' | 'cancelled' | 'interrupted'

// One field export as GET /api/exports reports it. 'starting' exists only on
// this side: the row the page shows between clicking Download and the server
// picking the request up.
export interface ExportJob {
  id: string
  connection_id: string
  topic: string
  fields: string[]
  status: ExportStatus
  read: number
  total: number
  rows: number
  started_at: string
  finished_at?: string
  error?: string
}

const POLL_MS = 1000
// A download the server has not seen by then was never sent (blocked by the
// browser, say). Kept short of forever so the row does not spin indefinitely.
const START_GRACE_MS = 30_000

interface ExportsStore {
  jobs: ExportJob[]
  expanded: boolean
  setExpanded: (expanded: boolean) => void
  track: (job: Pick<ExportJob, 'id' | 'connection_id' | 'topic' | 'fields'>) => void
  refresh: () => Promise<void>
  stop: (id: string) => Promise<void>
}

let pollTimer: number | null = null

// newExportId names a download before it is sent, so its row can appear at
// once. getRandomValues rather than randomUUID: the latter only exists in a
// secure context, and Kizuna is often opened over plain http on a LAN address.
export function newExportId(): string {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

const NEVER_STARTED = 'The download never reached the server.'

// mergeJobs lays the server's list over the rows only this page knows about:
// downloads not picked up yet, and those that never were.
export function mergeJobs(server: ExportJob[], local: ExportJob[], now: number): ExportJob[] {
  const known = new Set(server.map((job) => job.id))
  const pending = local
    .filter((job) => !known.has(job.id) && (job.status === 'starting' || job.error === NEVER_STARTED))
    .map((job) =>
      job.status === 'starting' && now - Date.parse(job.started_at) > START_GRACE_MS
        ? { ...job, status: 'failed' as const, error: NEVER_STARTED, finished_at: new Date(now).toISOString() }
        : job
    )
  return [...pending, ...server]
}

export const useExportsStore = create<ExportsStore>((set, get) => {
  const schedule = () => {
    if (pollTimer !== null) return
    if (!get().jobs.some(isActive)) return
    pollTimer = window.setTimeout(() => {
      pollTimer = null
      void get().refresh()
    }, POLL_MS)
  }

  return {
    jobs: [],
    expanded: false,

    setExpanded: (expanded) => set({ expanded }),

    track: (job) => {
      set((state) => ({
        jobs: [
          { ...job, status: 'starting', read: 0, total: 0, rows: 0, started_at: new Date().toISOString() },
          ...state.jobs.filter((existing) => existing.id !== job.id),
        ],
      }))
      schedule()
    },

    refresh: async () => {
      try {
        const res = await apiFetch('/api/exports')
        await throwOnApiError(res)
        const server = (await res.json()) as ExportJob[]
        set((state) => ({ jobs: mergeJobs(server, state.jobs, Date.now()) }))
      } catch {
        // The panel keeps what it last knew; the next poll tries again.
      }
      schedule()
    },

    // stop cancels a running export or dismisses a finished one; the server
    // decides which from the export's state.
    stop: async (id) => {
      const job = get().jobs.find((candidate) => candidate.id === id)
      if (job && !isActive(job)) {
        set((state) => ({ jobs: state.jobs.filter((candidate) => candidate.id !== id) }))
      }
      if (job?.status === 'starting') {
        return
      }
      try {
        const res = await apiFetch(`/api/exports/${encodeURIComponent(id)}`, { method: 'DELETE' })
        if (res.status !== 404) await throwOnApiError(res)
      } catch {
        // Reflected by the next refresh either way.
      }
      await get().refresh()
    },
  }
})
