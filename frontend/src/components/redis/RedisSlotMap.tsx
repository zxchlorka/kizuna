import { useMemo, useState } from 'react'
import { formatExactCount } from '@/lib/numberFormat'
import { cn } from '@/lib/utils'

// Redis Cluster hashes every key into one of these, and only ever rebalances by
// moving them. So the ranges are the unit any fix is written in — the Masters
// table above can say a node is bigger, but not which part of the keyspace to
// move off it.
const TOTAL_SLOTS = 16384

export interface RedisSlotRange {
  start: number
  end: number
}

export interface RedisSlotNode {
  address: string
  keys: number
  used_memory: number
  maxmemory: number
  connected_clients: number
  slots?: number
  slot_ranges?: RedisSlotRange[]
  replicas?: number
}

type ColourMode = 'owner' | 'density' | 'memory'

const COLOUR_MODES: Array<{ id: ColourMode; label: string }> = [
  { id: 'owner', label: 'Owner' },
  { id: 'density', label: 'Keys per slot' },
  { id: 'memory', label: 'Memory' },
]

// Buckets are multiples of the cluster average, so the legend reads the same
// whatever the absolute numbers are.
const HEAT_LABELS = ['at the average', '1.25–1.75×', '1.75–2.5×', 'over 2.5×']

// Heat is relative to the cluster's own average, not to an absolute number: a
// cluster where every node holds 40k keys per slot is balanced, and colouring it
// all red would say the opposite.
const HEAT_CLASSES = [
  'bg-slate-300 dark:bg-slate-700',
  'bg-amber-400/70 dark:bg-amber-500/60',
  'bg-orange-500/80 dark:bg-orange-500/70',
  'bg-red-500/85 dark:bg-red-500/75',
]

export function heatIndex(value: number, average: number): number {
  if (average <= 0) return 0
  const ratio = value / average
  if (ratio < 1.25) return 0
  if (ratio < 1.75) return 1
  if (ratio < 2.5) return 2
  return 3
}

// Alternating neutrals rather than one colour per node: a six-colour ribbon
// looks equally alarming whether the cluster is healthy or not. Identity comes
// from position and label; colour is kept for what is wrong.
const OWNER_CLASSES = ['bg-slate-400/70 dark:bg-slate-500/50', 'bg-slate-300/80 dark:bg-slate-600/40']

export interface Segment {
  key: string
  start: number
  end: number
  slots: number
  node: RedisSlotNode | null
  ownerIndex: number
}

/**
 * The 16384 slots laid out in order, with every gap made explicit.
 *
 * Built by walking the sorted ranges rather than by concatenating each node's
 * share, so a slot nobody claims shows up in the position it is actually
 * missing from. An unclaimed slot means that part of the keyspace answers to
 * no one — the per-node table cannot show it, because every node it lists is
 * present and healthy.
 */
export function buildSegments(nodes: RedisSlotNode[]): Segment[] {
  const owned: Array<{ range: RedisSlotRange; node: RedisSlotNode; ownerIndex: number }> = []
  nodes.forEach((node, ownerIndex) => {
    ;(node.slot_ranges ?? []).forEach((range) => owned.push({ range, node, ownerIndex }))
  })
  owned.sort((a, b) => a.range.start - b.range.start)

  const segments: Segment[] = []
  let cursor = 0
  for (const { range, node, ownerIndex } of owned) {
    if (range.start > cursor) {
      segments.push({
        key: `gap-${cursor}`,
        start: cursor,
        end: range.start - 1,
        slots: range.start - cursor,
        node: null,
        ownerIndex: -1,
      })
    }
    segments.push({
      key: `${node.address}-${range.start}`,
      start: range.start,
      end: range.end,
      slots: range.end - range.start + 1,
      node,
      ownerIndex,
    })
    cursor = Math.max(cursor, range.end + 1)
  }
  if (cursor < TOTAL_SLOTS) {
    segments.push({
      key: `gap-${cursor}`,
      start: cursor,
      end: TOTAL_SLOTS - 1,
      slots: TOTAL_SLOTS - cursor,
      node: null,
      ownerIndex: -1,
    })
  }
  return segments
}

// A near-empty cluster has well under one key per slot, and rounding that to
// "0" reads as "this node is empty" next to a keys column that says otherwise.
export function formatDensity(density: number): string {
  if (density >= 10) return formatExactCount(Math.round(density))
  return density.toFixed(2)
}

// Cluster-wide keys per slot, the yardstick every row is coloured against.
// Exported so the Masters table marks the same rows hot as the ribbon does —
// two thresholds drifting apart would be worse than none.
export function averageDensity(nodes: RedisSlotNode[]): number {
  const withSlots = nodes.filter((node) => (node.slots ?? 0) > 0)
  const slots = withSlots.reduce((sum, node) => sum + (node.slots ?? 0), 0)
  if (slots === 0) return 0
  return withSlots.reduce((sum, node) => sum + node.keys, 0) / slots
}

export function formatRanges(ranges: RedisSlotRange[] | undefined): string {
  if (!ranges || ranges.length === 0) return '—'
  return ranges.map((range) => (range.start === range.end ? `${range.start}` : `${range.start}–${range.end}`)).join(', ')
}

export function RedisSlotRibbon({ nodes }: { nodes: RedisSlotNode[] }) {
  const [mode, setMode] = useState<ColourMode>('owner')

  const mapped = useMemo(() => nodes.filter((node) => (node.slots ?? 0) > 0), [nodes])

  const stats = useMemo(() => {
    const totalKeys = mapped.reduce((sum, node) => sum + node.keys, 0)
    const totalSlots = mapped.reduce((sum, node) => sum + (node.slots ?? 0), 0)
    const totalMemory = mapped.reduce((sum, node) => sum + node.used_memory, 0)
    return {
      totalKeys,
      totalSlots,
      totalMemory,
      avgDensity: totalSlots > 0 ? totalKeys / totalSlots : 0,
      avgMemoryPerSlot: totalSlots > 0 ? totalMemory / totalSlots : 0,
      unassigned: TOTAL_SLOTS - totalSlots,
    }
  }, [mapped])

  const segments = useMemo(() => buildSegments(mapped), [mapped])

  // The node worth naming: most keys per slot, and only when it is far enough
  // from the average to be worth a sentence.
  const skewed = useMemo(() => {
    if (mapped.length < 2 || stats.avgDensity <= 0) return null
    const worst = mapped.reduce((a, b) =>
      b.keys / (b.slots ?? 1) > a.keys / (a.slots ?? 1) ? b : a
    )
    const ratio = worst.keys / (worst.slots ?? 1) / stats.avgDensity
    return ratio >= 1.4 ? { node: worst, ratio } : null
  }, [mapped, stats.avgDensity])

  if (mapped.length === 0) {
    return null
  }

  const fillFor = (segment: Segment): string => {
    if (!segment.node) return 'bg-red-600 dark:bg-red-500'
    if (mode === 'owner') return OWNER_CLASSES[segment.ownerIndex % OWNER_CLASSES.length]
    const slots = segment.node.slots ?? 1
    const value = mode === 'density' ? segment.node.keys / slots : segment.node.used_memory / slots
    const average = mode === 'density' ? stats.avgDensity : stats.avgMemoryPerSlot
    return HEAT_CLASSES[heatIndex(value, average)]
  }

  const titleFor = (segment: Segment): string => {
    const span = `slots ${segment.start}–${segment.end} (${formatExactCount(segment.slots)})`
    if (!segment.node) return `${span} — owned by no one`
    return `${segment.node.address} · ${span} · ${formatDensity(segment.node.keys / (segment.node.slots ?? 1))} keys per slot`
  }

  return (
    <div className="border-b border-border">
      <div className="flex flex-wrap items-center justify-between gap-3 px-3 py-2">
        <div className="flex flex-wrap items-baseline gap-x-3">
          <span className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground">Slot map</span>
          <span className="font-mono text-[11px] text-muted-foreground">
            {formatExactCount(TOTAL_SLOTS)} slots · {mapped.length} masters
            {stats.unassigned > 0 && (
              <span className="text-red-600 dark:text-red-400">
                {' '}
                · {formatExactCount(stats.unassigned)} owned by no one
              </span>
            )}
          </span>
        </div>

        <div className="flex items-center gap-2">
          <span className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground">Colour by</span>
          <div className="inline-flex overflow-hidden rounded-sm border border-border">
            {COLOUR_MODES.map((option) => (
              <button
                key={option.id}
                type="button"
                aria-pressed={mode === option.id}
                onClick={() => setMode(option.id)}
                className={cn(
                  'px-2 py-1 font-mono text-[10px] uppercase tracking-[0.12em] transition-colors',
                  mode === option.id
                    ? 'bg-amber-500/15 text-amber-600 dark:text-amber-500'
                    : 'text-muted-foreground hover:text-foreground'
                )}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="flex flex-col gap-3 px-3 pb-3">
        <div>
          <div className="flex h-11 overflow-hidden rounded-sm border border-border">
            {segments.map((segment) => (
              <div
                key={segment.key}
                title={titleFor(segment)}
                style={{ width: `${(segment.slots / TOTAL_SLOTS) * 100}%` }}
                className={cn('flex min-w-0 items-end border-l border-background/70 first:border-l-0', fillFor(segment))}
              >
                {/* Below ~6% the label has no room and turns into noise. The
                    address is written in full and left to truncate: shortening
                    it by hand guesses which part is the distinguishing one, and
                    on 10.0.4.11 and redis-01.example.internal the guesses differ. */}
                {segment.node && segment.slots / TOTAL_SLOTS > 0.06 && (
                  <span className="truncate px-1 pb-0.5 font-mono text-[9px] text-foreground/70">
                    {segment.node.address}
                  </span>
                )}
              </div>
            ))}
          </div>
          <div className="mt-1 flex justify-between font-mono text-[9px] tabular-nums text-muted-foreground">
            <span>0</span>
            <span>4096</span>
            <span>8192</span>
            <span>12288</span>
            <span>16383</span>
          </div>

          {/* A colour scale with no key is a guessing game, but in Owner mode
              the shades mean nothing beyond "next node" and a legend would
              invite reading meaning into them. */}
          {mode !== 'owner' && (
            <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 font-mono text-[10px] text-muted-foreground">
              {HEAT_LABELS.map((label, index) => (
                <span key={label} className="inline-flex items-center gap-1.5">
                  <span className={cn('inline-block h-2.5 w-2.5 rounded-[1px]', HEAT_CLASSES[index])} />
                  {label}
                </span>
              ))}
            </div>
          )}
        </div>

        {skewed && (
          <div className="flex items-start gap-2 rounded-sm border border-amber-500/35 bg-amber-500/[0.08] px-3 py-2 font-mono text-[11px] leading-relaxed">
            <span className="shrink-0 pt-px text-[10px] uppercase tracking-[0.14em] text-amber-600 dark:text-amber-500">
              Skew
            </span>
            <span>
              <span className="text-foreground">{skewed.node.address}</span> owns{' '}
              {(((skewed.node.slots ?? 0) / TOTAL_SLOTS) * 100).toFixed(1)}% of the slots and holds{' '}
              {stats.totalKeys > 0 ? ((skewed.node.keys / stats.totalKeys) * 100).toFixed(1) : '0'}% of the keys —{' '}
              {skewed.ratio.toFixed(1)}× the cluster's density. Losing this node takes that much more of the keyspace
              with it.
            </span>
          </div>
        )}

      </div>
    </div>
  )
}
