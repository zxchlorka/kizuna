import { afterEach, describe, expect, it, vi } from 'vitest'
import { clipboardFailureMessage, writeClipboardText } from '@/lib/clipboard'

// Minimal DOM stand-ins: this suite runs in vitest's node environment (no
// jsdom), so `document`/`navigator` don't exist unless stubbed. legacyCopy
// only touches a handful of Element/Document methods, so a lightweight fake
// is enough rather than pulling in a full DOM implementation.
function createFakeElement() {
  const style: Record<string, string> = {}
  return {
    value: '',
    style,
    attributes: {} as Record<string, string>,
    setAttribute(name: string, value: string) {
      this.attributes[name] = value
    },
    focus: vi.fn(),
    select: vi.fn(),
  }
}

function stubDom(options: { execCommandResult: boolean | 'throw'; hasExecCommand?: boolean }) {
  const appended: unknown[] = []
  const removed: unknown[] = []
  const activeElementFocus = vi.fn()
  const execCommand = vi.fn(() => {
    if (options.execCommandResult === 'throw') {
      throw new Error('execCommand blocked')
    }
    return options.execCommandResult
  })

  const documentStub: Record<string, unknown> = {
    createElement: vi.fn(() => createFakeElement()),
    body: {
      appendChild: vi.fn((el: unknown) => appended.push(el)),
      removeChild: vi.fn((el: unknown) => removed.push(el)),
    },
    activeElement: { focus: activeElementFocus },
  }
  if (options.hasExecCommand !== false) {
    documentStub.execCommand = execCommand
  }

  vi.stubGlobal('document', documentStub)
  return { execCommand, appended, removed, activeElementFocus }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('writeClipboardText — modern Clipboard API path', () => {
  it('uses navigator.clipboard.writeText when available and succeeds', async () => {
    const writeText = vi.fn(() => Promise.resolve())
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    const execCommand = vi.fn()
    vi.stubGlobal('document', { execCommand })

    const result = await writeClipboardText('hello')

    expect(result).toEqual({ ok: true, method: 'clipboard-api' })
    expect(writeText).toHaveBeenCalledWith('hello')
    expect(execCommand).not.toHaveBeenCalled()
  })

  it('falls back to the legacy path when the Clipboard API call rejects', async () => {
    const writeText = vi.fn(() => Promise.reject(new Error('permission denied')))
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    const { execCommand } = stubDom({ execCommandResult: true })

    const result = await writeClipboardText('hello')

    expect(result).toEqual({ ok: true, method: 'exec-command' })
    expect(execCommand).toHaveBeenCalledWith('copy')
  })
})

describe('writeClipboardText — insecure-context fallback', () => {
  it('goes straight to execCommand when navigator.clipboard does not exist at all', async () => {
    // The realistic shape of `navigator` outside a secure context: the object
    // exists, `clipboard` does not (not `navigator` itself being undefined).
    vi.stubGlobal('navigator', {})
    const { execCommand, appended, removed } = stubDom({ execCommandResult: true })

    const result = await writeClipboardText('insecure context text')

    expect(result).toEqual({ ok: true, method: 'exec-command' })
    expect(execCommand).toHaveBeenCalledWith('copy')
    expect(appended).toHaveLength(1)
    expect(removed).toHaveLength(1)
  })

  it('returns an honest failure — never a silent no-op — when nothing works', async () => {
    vi.stubGlobal('navigator', {})
    stubDom({ execCommandResult: false })

    const result = await writeClipboardText('text')

    expect(result).toEqual({ ok: false, reason: 'unavailable' })
  })

  it('returns failure when execCommand throws rather than returning false', async () => {
    vi.stubGlobal('navigator', {})
    stubDom({ execCommandResult: 'throw' })

    const result = await writeClipboardText('text')

    expect(result).toEqual({ ok: false, reason: 'unavailable' })
  })

  it('returns failure when document.execCommand does not exist either', async () => {
    vi.stubGlobal('navigator', {})
    stubDom({ execCommandResult: true, hasExecCommand: false })

    const result = await writeClipboardText('text')

    expect(result).toEqual({ ok: false, reason: 'unavailable' })
  })

  it('returns failure gracefully when document itself does not exist', async () => {
    vi.stubGlobal('navigator', {})
    vi.stubGlobal('document', undefined)

    const result = await writeClipboardText('text')

    expect(result).toEqual({ ok: false, reason: 'unavailable' })
  })
})

describe('clipboardFailureMessage', () => {
  it('gives an honest, specific reason rather than a generic error', () => {
    const message = clipboardFailureMessage()
    expect(message.toLowerCase()).toContain('unavailable')
    expect(message.toLowerCase()).toContain('http')
  })
})
