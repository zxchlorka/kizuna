import { useEffect, useState } from 'react'
import { ChevronDown, ChevronUp, Download } from 'lucide-react'
import { ConfirmDialog } from '@/components/ConfirmDialog'
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

function statusText(job: ExportJob): string {
  return job.status === 'running' ? `${exportPercent(job).toFixed(1)}%` : statusLabel[job.status]
}

const statusTone = (job: ExportJob) =>
  job.status === 'failed' || job.status === 'interrupted' ? 'text-destructive' : 'text-muted-foreground'

function ExportRow({
  job,
  now,
  onStop,
  onDismiss,
}: {
  job: ExportJob
  now: number
  onStop: (id: string) => void
  onDismiss: (id: string) => void
}) {
  const percent = exportPercent(job)
  return (
    <div className="px-3 py-2.5" title={`${job.topic}: ${job.fields.join(', ')}`}>
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate font-mono text-xs text-foreground">
          {job.topic}
          <span className="text-muted-foreground"> {job.fields.join(', ')}</span>
        </span>
        <span className={cn('shrink-0 font-mono text-[11px] tabular-nums', statusTone(job))}>{statusText(job)}</span>
        {/* Nothing while starting: the server does not know this export yet. */}
        {job.status === 'running' && (
          <button
            type="button"
            className="shrink-0 rounded-sm font-mono text-[11px] text-muted-foreground transition-colors hover:text-destructive"
            onClick={() => onStop(job.id)}
            aria-label={`Stop the export of ${job.topic}`}
          >
            Stop
          </button>
        )}
        {!isActive(job) && (
          <button
            type="button"
            className="shrink-0 rounded-sm font-mono text-[11px] text-muted-foreground transition-colors hover:text-foreground"
            onClick={() => onDismiss(job.id)}
            aria-label={`Dismiss the export of ${job.topic}`}
          >
            Dismiss
          </button>
        )}
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

// ExportsPanel sits bottom-right on every page while there are field exports to
// show, folded to one line unless opened, so it does not cover the page.
export function ExportsPanel() {
  const jobs = useExportsStore((state) => state.jobs)
  const expanded = useExportsStore((state) => state.expanded)
  const setExpanded = useExportsStore((state) => state.setExpanded)
  const refresh = useExportsStore((state) => state.refresh)
  const stop = useExportsStore((state) => state.stop)
  const [stoppingId, setStoppingId] = useState<string | null>(null)

  // Picks up exports still running after a reload of the page.
  useEffect(() => {
    void refresh()
  }, [refresh])

  if (jobs.length === 0) {
    return null
  }

  const now = Date.now()
  const summary = summarizeExports(jobs)
  const single = jobs.length === 1 ? jobs[0] : null
  // Looked up live, so the warning closes itself if the export ends meanwhile.
  const stopping = jobs.find((job) => job.id === stoppingId && job.status === 'running') ?? null

  return (
    <>
      <div
        className={cn(
          'fixed bottom-4 right-4 z-50 max-w-[calc(100vw-2rem)] rounded-sm border border-border bg-card shadow-lg',
          expanded ? 'w-[22rem]' : 'w-72'
        )}
      >
        {expanded && (
          <div className="max-h-[50vh] divide-y divide-border overflow-y-auto border-b border-border">
            {jobs.map((job) => (
              <ExportRow key={job.id} job={job} now={now} onStop={setStoppingId} onDismiss={(id) => void stop(id)} />
            ))}
          </div>
        )}
        <button
          type="button"
          className="flex w-full items-center gap-2 px-3 py-2 text-left"
          onClick={() => setExpanded(!expanded)}
          aria-expanded={expanded}
          title={single ? `${single.topic}: ${single.fields.join(', ')}` : undefined}
        >
          <Download className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1 truncate font-mono text-xs text-foreground">
            {single && !expanded ? single.topic : `${summary.count} export${summary.count === 1 ? '' : 's'}`}
            {!single && summary.running > 0 && (
              <span className="text-muted-foreground">
                {' '}
                · {summary.running} running · {Math.floor(summary.percent)}%
              </span>
            )}
          </span>
          {single && !expanded && (
            <span className={cn('shrink-0 font-mono text-[11px] tabular-nums', statusTone(single))}>{statusText(single)}</span>
          )}
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

      <ConfirmDialog
        open={stopping !== null}
        title="Stop this export?"
        description={
          stopping && (
            <>
              <span className="font-mono">{stopping.topic}</span> is at {statusText(stopping)}. Stopping fails the download
              and all progress is lost: an export cannot resume, so the next run starts from the beginning.
            </>
          )
        }
        confirmLabel="Stop export"
        destructive
        onOpenChange={(open) => {
          if (!open) setStoppingId(null)
        }}
        onConfirm={() => {
          if (stoppingId !== null) void stop(stoppingId)
          setStoppingId(null)
        }}
      />
    </>
  )
}
