import { afterEach, describe, expect, it, vi } from 'vitest'
import { clipboardFailureMessage, writeClipboardText } from '@/lib/clipboard'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('writeClipboardText', () => {
  it('writes through navigator.clipboard when it is available', async () => {
    const writeText = vi.fn(() => Promise.resolve())
    vi.stubGlobal('navigator', { clipboard: { writeText } })

    expect(await writeClipboardText('hello')).toBe(true)
    expect(writeText).toHaveBeenCalledWith('hello')
  })

  it('reports failure — never a silent success — when the write rejects', async () => {
    const writeText = vi.fn(() => Promise.reject(new Error('permission denied')))
    vi.stubGlobal('navigator', { clipboard: { writeText } })

    expect(await writeClipboardText('hello')).toBe(false)
  })

  it('reports failure outside a secure context, where navigator.clipboard is absent', async () => {
    // The realistic shape there: `navigator` exists, `clipboard` does not.
    vi.stubGlobal('navigator', {})

    expect(await writeClipboardText('text')).toBe(false)
  })

  it('reports failure rather than throwing when navigator itself is absent', async () => {
    vi.stubGlobal('navigator', undefined)

    expect(await writeClipboardText('text')).toBe(false)
  })
})

describe('clipboardFailureMessage', () => {
  it('gives an honest, specific reason rather than a generic error', () => {
    const message = clipboardFailureMessage()
    expect(message.toLowerCase()).toContain('unavailable')
    expect(message.toLowerCase()).toContain('http')
  })
})
