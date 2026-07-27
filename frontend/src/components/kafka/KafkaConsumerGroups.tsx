import { Fragment, useState } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { EmptyState } from '@/components/EmptyState'
import { formatCompactCount, formatExactCount, splitSharedPrefix } from '@/lib/numberFormat'
import { cn } from '@/lib/utils'
import type { ObjectItem } from '@/types/api'

interface PartitionLag {
  partition: number
  current_offset: number
  end_offset: number
  lag: number
}

function groupLags(group: ObjectItem): PartitionLag[] {
  const raw = group.meta?.partitions
  return Array.isArray(raw) ? (raw as PartitionLag[]) : []
}

// One severity read per group, not per partition. The absolute thresholds below
// saturate at 10k, so on a group lagging by millions every partition bar came
// out the same red and the colour said nothing while the eye still had to
// process it. Severity is stated once by the group's badge; inside the group the
// bars share that one tone and LENGTH does the comparing.
function lagBarTone(groupLag: number): string {
  if (groupLag < 100) {
    return 'bg-emerald-500/60'
  }
  if (groupLag < 10000) {
    return 'bg-amber-500/60'
  }
  return 'bg-red-500/50'
}

function lagBadgeTone(lag: number): string {
  if (lag < 100) {
    return 'border-emerald-500/20 bg-emerald-500/5 text-emerald-500'
  }
  if (lag < 10000) {
    return 'border-amber-500/20 bg-amber-500/5 text-amber-500'
  }
  return 'border-red-500/20 bg-red-500/5 text-red-500'
}

export function KafkaConsumerGroups({ groups }: { groups: ObjectItem[] }) {
  const [expanded, setExpanded] = useState<string | null>(null)

  if (groups.length === 0) {
    return (
      <EmptyState
        variant="no_tables"
        compact
        title="No consumer groups"
        description="No group has committed offsets for this topic yet."
      />
    )
  }

  return (
    <div className="overflow-x-auto rounded-sm border border-border/70">
      <table className="min-w-full divide-y divide-border text-sm">
        <thead className="bg-muted/30 text-left text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
          <tr>
            <th className="w-8 px-2 py-2" />
            <th className="px-3 py-2">Group</th>
            <th className="px-3 py-2">State</th>
            <th className="px-3 py-2">Members</th>
            <th className="px-3 py-2">Total lag</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border/60">
          {groups.map((group) => {
            const isExpanded = expanded === group.name
            const lags = groupLags(group)
            const maxLag = Math.max(1, ...lags.map((lag) => lag.lag))
            const state = typeof group.meta?.state === 'string' && group.meta.state !== '' ? group.meta.state : 'Unknown'
            const members = typeof group.meta?.members === 'number' ? group.meta.members : 0

            return (
              <Fragment key={group.name}>
                <tr
                  className="cursor-pointer transition-colors hover:bg-muted/30"
                  onClick={() => setExpanded(isExpanded ? null : group.name)}
                >
                  <td className="px-2 py-2 text-muted-foreground">
                    {isExpanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                  </td>
                  <td className="px-3 py-2 font-mono text-xs">{group.name}</td>
                  <td className="px-3 py-2 font-mono text-xs text-muted-foreground">{state}</td>
                  <td className="px-3 py-2 font-mono text-xs">{members}</td>
                  <td className="px-3 py-2">
                    <span
                      className={cn('rounded-sm border px-1.5 py-0.5 font-mono text-[10px] tabular-nums', lagBadgeTone(group.row_count))}
                      title={`${formatExactCount(group.row_count)} messages behind`}
                    >
                      {formatCompactCount(group.row_count)}
                    </span>
                  </td>
                </tr>
                {isExpanded && (
                  <tr>
                    <td colSpan={5} className="p-0">
                      <div className="space-y-1.5 border-t border-border/60 bg-muted/10 px-4 py-3">
                        {lags.map((partitionLag) => {
                          const committed = partitionLag.current_offset < 0 ? null : formatExactCount(partitionLag.current_offset)
                          const end = formatExactCount(partitionLag.end_offset)
                          // A partition's committed and end offsets share a long
                          // leading run of digits, so the delta is invisible when
                          // both are printed flat. Dimming the shared part keeps
                          // full precision while putting the eye on what differs.
                          const committedSplit = committed ? splitSharedPrefix(committed, end) : null
                          const endSplit = committed ? splitSharedPrefix(end, committed) : { prefix: '', rest: end }

                          return (
                            <div key={partitionLag.partition} className="flex items-center gap-3 font-mono text-xs">
                              <span className="w-10 shrink-0 text-muted-foreground">p{partitionLag.partition}</span>
                              <div className="h-2 min-w-16 flex-1 overflow-hidden rounded-full bg-muted/40">
                                <div
                                  className={cn('h-full rounded-full transition-all', lagBarTone(group.row_count))}
                                  style={{ width: `${Math.min(100, (partitionLag.lag / maxLag) * 100)}%` }}
                                />
                              </div>

                              {/* Reference data: dimmed, one line, full precision. */}
                              <span
                                className="hidden shrink-0 whitespace-nowrap text-[11px] text-muted-foreground/40 tabular-nums md:inline"
                                title={`Committed ${committed ?? 'none'} of ${end}`}
                              >
                                {committedSplit ? (
                                  <>
                                    {committedSplit.prefix}
                                    <span className="text-muted-foreground/80">{committedSplit.rest}</span>
                                  </>
                                ) : (
                                  <span className="text-muted-foreground/80">no commit</span>
                                )}
                                <span className="px-1.5 text-muted-foreground/30">/</span>
                                {endSplit.prefix}
                                <span className="text-muted-foreground/80">{endSplit.rest}</span>
                              </span>

                              {/* The number this panel exists to show. */}
                              <span
                                className="w-20 shrink-0 text-right tabular-nums"
                                title={`${formatExactCount(partitionLag.lag)} messages behind`}
                              >
                                {formatCompactCount(partitionLag.lag)}
                              </span>
                            </div>
                          )
                        })}
                      </div>
                    </td>
                  </tr>
                )}
              </Fragment>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
