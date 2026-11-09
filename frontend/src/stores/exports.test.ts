import { describe, expect, it } from 'vitest'
import { mergeJobs, newExportId, type ExportJob } from '@/stores/exports'

const now = Date.parse('2026-03-01T10:00:00.000Z')

function job(id: string, patch: Partial<ExportJob> = {}): ExportJob {
  return {
    id,
    connection_id: 'c',
    topic: 'events',
    fields: ['user_id'],
    status: 'running',
    read: 0,
    total: 0,
    rows: 0,
    started_at: new Date(now - 1000).toISOString(),
    ...patch,
  }
}

describe('mergeJobs', () => {
  it('keeps a download the server has not picked up yet', () => {
    const merged = mergeJobs([], [job('a', { status: 'starting' })], now)
    expect(merged.map((j) => [j.id, j.status])).toEqual([['a', 'starting']])
  })

  it('takes the server row once the server knows the export', () => {
    const merged = mergeJobs([job('a', { read: 5, total: 10 })], [job('a', { status: 'starting' })], now)
    expect(merged).toHaveLength(1)
    expect(merged[0].read).toBe(5)
  })

  it('gives up on a download the server never saw', () => {
    const old = job('a', { status: 'starting', started_at: new Date(now - 60_000).toISOString() })
    const merged = mergeJobs([], [old], now)
    expect(merged[0].status).toBe('failed')
    expect(merged[0].error).toMatch(/never reached/)
  })

  it('drops a finished export the server no longer lists', () => {
    expect(mergeJobs([], [job('a', { status: 'done' })], now)).toEqual([])
  })
})

describe('newExportId', () => {
  it('is a 32-char hex id the backend accepts', () => {
    expect(newExportId()).toMatch(/^[0-9a-f]{32}$/)
    expect(newExportId()).not.toBe(newExportId())
  })
})
