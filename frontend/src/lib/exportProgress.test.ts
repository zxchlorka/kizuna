import { describe, expect, it } from 'vitest'
import { exportEtaSeconds, exportPercent, exportRate, formatDuration, summarizeExports } from '@/lib/exportProgress'
import type { ExportJob } from '@/stores/exports'

const started = '2026-03-01T10:00:00.000Z'
const at = (seconds: number) => Date.parse(started) + seconds * 1000

function job(patch: Partial<ExportJob>): ExportJob {
  return {
    id: 'j',
    connection_id: 'c',
    topic: 'events',
    fields: ['user_id'],
    status: 'running',
    read: 0,
    total: 0,
    rows: 0,
    started_at: started,
    ...patch,
  }
}

describe('exportPercent', () => {
  it('is read over total', () => {
    expect(exportPercent(job({ read: 25, total: 200 }))).toBe(12.5)
  })
  it('never passes 100', () => {
    expect(exportPercent(job({ read: 210, total: 200 }))).toBe(100)
  })
  it('is 0 before the total is known, 100 once an empty export is done', () => {
    expect(exportPercent(job({}))).toBe(0)
    expect(exportPercent(job({ status: 'done' }))).toBe(100)
  })
})

describe('exportRate and exportEtaSeconds', () => {
  it('averages messages per second since the start', () => {
    expect(exportRate(job({ read: 1000 }), at(10))).toBe(100)
  })
  it('measures a finished export up to when it finished', () => {
    expect(exportRate(job({ read: 1000, status: 'done', finished_at: new Date(at(20)).toISOString() }), at(500))).toBe(50)
  })
  it('estimates what is left at that rate', () => {
    expect(exportEtaSeconds(job({ read: 1000, total: 5000 }), at(10))).toBe(40)
  })
  it('has no estimate before anything was read or after it ended', () => {
    expect(exportEtaSeconds(job({ total: 5000 }), at(10))).toBeNull()
    expect(exportEtaSeconds(job({ read: 10, total: 50, status: 'failed' }), at(10))).toBeNull()
  })
})

describe('formatDuration', () => {
  it.each([
    [45, '45s'],
    [125, '2m 05s'],
    [3600 + 5 * 60, '1h 05m'],
  ])('%d seconds reads %s', (seconds, text) => {
    expect(formatDuration(seconds)).toBe(text)
  })
})

describe('summarizeExports', () => {
  it('weights the running exports by size', () => {
    const summary = summarizeExports([
      job({ id: 'a', read: 100, total: 100 }),
      job({ id: 'b', read: 0, total: 300 }),
      job({ id: 'c', status: 'done', read: 50, total: 50 }),
    ])
    expect(summary).toEqual({ count: 3, running: 2, percent: 25 })
  })
  it('counts a starting export as running', () => {
    expect(summarizeExports([job({ status: 'starting' })]).running).toBe(1)
  })
})
