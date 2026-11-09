import type { ExportJob } from '@/stores/exports'

// Formatting for the export progress panel. read/total are offsets, not rows:
// the total is known the moment an export starts, rows only at its end.

export function isActive(job: ExportJob): boolean {
  return job.status === 'running' || job.status === 'starting'
}

export function exportPercent(job: ExportJob): number {
  if (job.total <= 0) {
    return job.status === 'done' ? 100 : 0
  }
  return Math.min(100, (job.read / job.total) * 100)
}

function elapsedSeconds(job: ExportJob, now: number): number {
  const end = job.finished_at ? Date.parse(job.finished_at) : now
  return Math.max(0, (end - Date.parse(job.started_at)) / 1000)
}

// Messages per second since the export started.
export function exportRate(job: ExportJob, now: number): number {
  const seconds = elapsedSeconds(job, now)
  return seconds > 0 ? job.read / seconds : 0
}

// Seconds left at the average rate so far; null while there is nothing to go on.
export function exportEtaSeconds(job: ExportJob, now: number): number | null {
  const rate = exportRate(job, now)
  if (!isActive(job) || rate <= 0) {
    return null
  }
  return Math.max(0, (job.total - job.read) / rate)
}

export function exportElapsedSeconds(job: ExportJob, now: number): number {
  return elapsedSeconds(job, now)
}

export function formatDuration(totalSeconds: number): string {
  const seconds = Math.round(totalSeconds)
  if (seconds < 60) {
    return `${seconds}s`
  }
  const pad = (n: number) => String(n).padStart(2, '0')
  if (seconds < 3600) {
    return `${Math.floor(seconds / 60)}m ${pad(seconds % 60)}s`
  }
  return `${Math.floor(seconds / 3600)}h ${pad(Math.floor((seconds % 3600) / 60))}m`
}

const compact = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 })

export function compactNumber(value: number): string {
  return compact.format(value)
}

// The collapsed panel's one line: how many exports, how many still going, and
// how far the going ones are together, weighted by size so a small finished
// export does not make a long one look nearly done.
export function summarizeExports(jobs: ExportJob[]): { count: number; running: number; percent: number } {
  const active = jobs.filter(isActive)
  const read = active.reduce((sum, job) => sum + job.read, 0)
  const total = active.reduce((sum, job) => sum + job.total, 0)
  return { count: jobs.length, running: active.length, percent: total > 0 ? (read / total) * 100 : 0 }
}
