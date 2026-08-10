// Number presentation for counts that routinely run to 8–12 digits (Kafka
// offsets and consumer lag). Nobody reads those digit by digit, so the display
// form carries magnitude and the exact value stays available on hover.

// Pinned to en-US rather than the browser locale: the rest of the UI is English
// and monospace, and a locale-driven "9,7 млн" would break both the wording and
// the column alignment.
const compactFormatter = new Intl.NumberFormat('en-US', {
  notation: 'compact',
  maximumFractionDigits: 2,
})

// formatCompactCount renders a magnitude: 9729467 -> "9.73M". Values below 10000
// are left exact, because that is the range where individual units still mean
// something (a lag of 4 is different from a lag of 400, but 9.73M and 9.74M are
// not).
export function formatCompactCount(value: number): string {
  if (!Number.isFinite(value)) return '\u2014'
  if (Math.abs(value) < 10000) return formatExactCount(value)
  return compactFormatter.format(value)
}

// formatExactCount is the full value for tooltips and anywhere precision is the
// point, with plain spaces grouping the digits so a 12-digit offset can be read
// without the groups being mistaken for separate columns.
//
// Grouped by hand rather than through Intl on purpose: the separator en-US
// resolves to is ICU-version dependent (some builds emit U+202F, a narrow
// no-break space, rather than a comma), and these values sit in monospace
// columns where the separator width has to be predictable. Doing it here also
// makes the output identical across every browser the app runs in.
export function formatExactCount(value: number): string {
  if (!Number.isFinite(value)) return '\u2014'
  const rounded = Math.trunc(value)
  const grouped = Math.abs(rounded)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ' ')
  return rounded < 0 ? `-${grouped}` : grouped
}

export interface SharedPrefixSplit {
  // Leading digits both values have in common — rendered dimmed.
  prefix: string
  // Where the two values start to differ — the part actually worth reading.
  rest: string
}

// splitSharedPrefix separates the leading digits two formatted numbers share.
//
// A partition's committed and end offsets differ only in their last few digits
// (137 771 731 278 vs 137 781 460 745), so shown plainly the reader has to diff
// twelve digits to find the delta. Dimming the common prefix puts the eye
// straight on the part that differs while keeping full precision on screen.
//
// Returns an empty prefix when the two cannot be compared digit-for-digit —
// different magnitudes, or values that are entirely equal, where there is no
// meaningful "differing part" to highlight.
export function splitSharedPrefix(value: string, other: string): SharedPrefixSplit {
  if (value.length !== other.length || value === other) {
    return { prefix: '', rest: value }
  }
  let shared = 0
  while (shared < value.length && value[shared] === other[shared]) {
    shared += 1
  }
  return { prefix: value.slice(0, shared), rest: value.slice(shared) }
}

const BYTE_UNITS = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'] as const

// formatBytes renders a byte count in binary units: 250000000000 -> "232.83 GiB".
//
// Binary rather than decimal because that is what the servers report: Redis
// INFO's used_memory and Kafka's retention.bytes are both counted in bytes and
// conventionally read as GiB, and rendering 250000000000 as "250 GB" next to a
// server that calls it 232 GiB invites exactly the mismatch this screen exists
// to prevent.
export function formatBytes(value: number): string {
  if (!Number.isFinite(value)) return '—'
  const negative = value < 0
  let size = Math.abs(value)
  let unit = 0
  while (size >= 1024 && unit < BYTE_UNITS.length - 1) {
    size /= 1024
    unit += 1
  }
  // Whole bytes never get a fraction; larger units keep two digits, enough to
  // tell 232.83 GiB from 232.91 GiB without implying byte-level precision.
  const rendered = unit === 0 ? String(Math.round(size)) : size.toFixed(2)
  return `${negative ? '-' : ''}${rendered} ${BYTE_UNITS[unit]}`
}

// formatDurationSeconds renders an elapsed time at the two coarsest units that
// carry information: 1043400 -> "12d 1h". Uptime is read to answer "was this
// restarted recently", so seconds stop mattering once there are hours.
export function formatDurationSeconds(value: number): string {
  if (!Number.isFinite(value) || value < 0) return '—'
  const total = Math.floor(value)
  const days = Math.floor(total / 86400)
  const hours = Math.floor((total % 86400) / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = total % 60

  if (days > 0) return `${days}d ${hours}h`
  if (hours > 0) return `${hours}h ${minutes}m`
  if (minutes > 0) return `${minutes}m ${seconds}s`
  return `${seconds}s`
}
