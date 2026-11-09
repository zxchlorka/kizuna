import { useEffect } from 'react'
import { ChevronDown, ChevronUp, Download, X } from 'lucide-react'
import {
  compactNumber,
  exportElapsedSeconds,
  exportEtaSeconds,
  exportPercent,
  exportRate,
  formatDuration,
  isActive,
  summarizeExports,
} from '@/lib/exportProgress'
import { cn } from '@/lib/utils'
import { useExportsStore, type ExportJob } from '@/stores/exports'

const statusLabel: Record<ExportJob['status'], string> = {
  starting: 'Starting',
  running: '',
  done: 'Done',
  failed: 'Failed',
  cancelled: 'Stopped',
  interrupted: 'Interrupted',
}

const barTone: Record<ExportJob['status'], string> = {
  starting: 'bg-orange-500',
  running: 'bg-orange-500',
  done: 'bg-emerald-500',
  failed: 'bg-destructive',
  cancelled: 'bg-muted-foreground',
  interrupted: 'bg-destructive',
}

// detail is the line under the bar: how far and how fast while running, how it
// ended afterwards. Offsets are "messages" here: compaction and transaction
// markers make the total approximate, hence the tilde.
function detail(job: ExportJob, now: number): string {
  const percent = `${Math.floor(exportPercent(job))}%`
  switch (job.status) {
    case 'starting':
      return 'Waiting for the first batch…'
    case 'running': {
      const eta = exportEtaSeconds(job, now)
      const pace = `${compactNumber(exportRate(job, now))}/s`
      return `${compactNumber(job.read)} / ~${compactNumber(job.total)} messages · ${compactNumber(job.rows)} rows · ${pace}${eta === null ? '' : ` · ${formatDuration(eta)} left`}`
    }
    case 'done':
      return `${compactNumber(job.rows)} rows in ${formatDuration(exportElapsedSeconds(job, now))}`
    case 'cancelled':
      return `Stopped at ${percent}, ${compactNumber(job.rows)} rows written`
    case 'interrupted':
      return `The browser stopped downloading at ${percent}. Run the export again.`
    case 'failed':
      return job.error ?? 'The export failed.'
  }
}

function ExportRow({ job, now, onStop }: { job: ExportJob; now: number; onStop: (id: string) => void }) {
  const active = isActive(job)
  const percent = exportPercent(job)
  return (
    <div className="px-3 py-2.5" title={`${job.topic}: ${job.fields.join(', ')}`}>
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate font-mono text-xs text-foreground">
          {job.topic}
          <span className="text-muted-foreground"> {job.fields.join(', ')}</span>
        </span>
        <span
          className={cn(
            'shrink-0 font-mono text-[11px] tabular-nums',
            job.status === 'failed' || job.status === 'interrupted' ? 'text-destructive' : 'text-muted-foreground'
          )}
        >
          {job.status === 'running' ? `${percent.toFixed(1)}%` : statusLabel[job.status]}
        </span>
        <button
          type="button"
          className="shrink-0 rounded-sm p-0.5 text-muted-foreground transition-colors hover:text-foreground"
          onClick={() => onStop(job.id)}
          title={active ? 'Stop this export' : 'Dismiss'}
          aria-label={active ? `Stop the export of ${job.topic}` : `Dismiss the export of ${job.topic}`}
        >
          <X className="h-3 w-3" />
        </button>
      </div>
      <div
        className="mt-1.5 h-1 overflow-hidden rounded-full bg-muted"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(percent)}
        aria-label={`Export of ${job.topic}`}
      >
        <div
          className={cn('h-full transition-[width] duration-700 ease-out', barTone[job.status], job.status === 'starting' && 'w-1/4 animate-pulse')}
          style={job.status === 'starting' ? undefined : { width: `${percent}%` }}
        />
      </div>
      <p className="mt-1.5 font-mono text-[11px] leading-snug text-muted-foreground">{detail(job, now)}</p>
    </div>
  )
}

// ExportsPanel sits bottom-left on every page while there are field exports to
// show. One export is shown in full; several fold into a single summary line
// that opens on click, so a batch of downloads does not cover the sidebar.
export function ExportsPanel() {
  const jobs = useExportsStore((state) => state.jobs)
  const expanded = useExportsStore((state) => state.expanded)
  const setExpanded = useExportsStore((state) => state.setExpanded)
  const refresh = useExportsStore((state) => state.refresh)
  const stop = useExportsStore((state) => state.stop)

  // Picks up exports still running after a reload of the page.
  useEffect(() => {
    void refresh()
  }, [refresh])

  if (jobs.length === 0) {
    return null
  }

  const now = Date.now()
  const onStop = (id: string) => void stop(id)

  if (jobs.length === 1) {
    return (
      <div className="fixed bottom-4 left-4 z-[60] w-[22rem] max-w-[calc(100vw-2rem)] rounded-sm border border-border bg-card shadow-lg">
        <ExportRow job={jobs[0]} now={now} onStop={onStop} />
      </div>
    )
  }

  const summary = summarizeExports(jobs)
  return (
    <div className="fixed bottom-4 left-4 z-[60] w-[22rem] max-w-[calc(100vw-2rem)] rounded-sm border border-border bg-card shadow-lg">
      {expanded && (
        <div className="max-h-[50vh] divide-y divide-border overflow-y-auto border-b border-border">
          {jobs.map((job) => (
            <ExportRow key={job.id} job={job} now={now} onStop={onStop} />
          ))}
        </div>
      )}
      <button
        type="button"
        className="flex w-full items-center gap-2 px-3 py-2 text-left"
        onClick={() => setExpanded(!expanded)}
        aria-expanded={expanded}
      >
        <Download className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate font-mono text-xs text-foreground">
          {summary.count} exports
          {summary.running > 0 && (
            <span className="text-muted-foreground">
              {' '}
              · {summary.running} running · {Math.floor(summary.percent)}%
            </span>
          )}
        </span>
        {expanded ? (
          <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronUp className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        )}
      </button>
      {!expanded && summary.running > 0 && (
        <div className="h-0.5 bg-muted">
          <div className="h-full bg-orange-500 transition-[width] duration-700 ease-out" style={{ width: `${summary.percent}%` }} />
        </div>
      )}
    </div>
  )
}
