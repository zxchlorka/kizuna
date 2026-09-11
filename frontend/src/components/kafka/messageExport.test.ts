import { describe, expect, it } from 'vitest'
import { messageEnvelope } from '@/components/kafka/KafkaMessageDetail'
import { matchesExport } from '@/components/kafka/KafkaMessageBrowser'
import type { KafkaMessageRow } from '@/stores/kafka'

const SNOWFLAKE = '2091885016401416192'

function row(value: string, format = 'json'): KafkaMessageRow {
  return {
    partition: 3,
    offset: 42,
    timestamp: '2026-09-09T11:22:53.475Z',
    key: 'k-1',
    value,
    format,
    headers: { trace: 'abc' },
  } as KafkaMessageRow
}

describe('messageEnvelope', () => {
  it('keeps an int64 in the payload exactly', () => {
    const text = messageEnvelope(row(`{"profile_id":${SNOWFLAKE}}`))
    expect(text).toContain(SNOWFLAKE)
    expect(text).not.toContain('2091885016401416200')
  })

  it('produces valid JSON carrying the envelope', () => {
    const parsed = JSON.parse(messageEnvelope(row('{"a":[1,2],"b":"x"}')))
    expect(parsed.partition).toBe(3)
    expect(parsed.offset).toBe(42)
    expect(parsed.key).toBe('k-1')
    expect(parsed.headers).toEqual({ trace: 'abc' })
    expect(parsed.value).toEqual({ a: [1, 2], b: 'x' })
  })

  it('embeds a non-JSON payload as a string rather than failing', () => {
    const parsed = JSON.parse(messageEnvelope(row('plain "quoted" text', 'text')))
    expect(parsed.value).toBe('plain "quoted" text')
  })

  it('embeds a payload that claims json but does not parse', () => {
    const parsed = JSON.parse(messageEnvelope(row('{not json', 'json')))
    expect(parsed.value).toBe('{not json')
  })
})

describe('matchesExport', () => {
  it('names the topic and whether the scan finished', () => {
    const parsed = JSON.parse(matchesExport('events_v2', [row('{"a":1}')], false))
    expect(parsed.topic).toBe('events_v2')
    expect(parsed.scan_complete).toBe(false)
    expect(parsed.matches).toBe(1)
    expect(parsed.messages).toHaveLength(1)
    expect(parsed.messages[0].offset).toBe(42)
  })

  // A cancelled or capped scan yields a partial list, and a bare array could
  // not be told apart from a complete answer a week later.
  it('stays valid JSON with no matches at all', () => {
    const parsed = JSON.parse(matchesExport('events_v2', [], true))
    expect(parsed.messages).toEqual([])
    expect(parsed.scan_complete).toBe(true)
  })

  it('keeps int64 values across several messages', () => {
    const text = matchesExport('t', [row(`{"id":${SNOWFLAKE}}`), row(`{"id":${SNOWFLAKE}}`)], true)
    expect(JSON.parse(text).messages).toHaveLength(2)
    expect(text.match(new RegExp(SNOWFLAKE, 'g'))).toHaveLength(2)
  })
})
