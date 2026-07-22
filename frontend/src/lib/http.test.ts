import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchWithTimeout, RequestAbortedError } from '@/lib/http'

// fetchWithTimeout references window.setTimeout/clearTimeout; the test runs in
// the default node environment, so point `window` at globalThis (which provides
// real timers, AbortController and DOMException).
vi.stubGlobal('window', globalThis)

// A fetch stub that rejects with an AbortError the moment its signal aborts, and
// otherwise stays pending — the same shape as a real slow request, so both the
// internal timeout and an external cancel exercise the abort path.
function abortAwareFetch(): typeof fetch {
  return vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
    return new Promise<Response>((resolve, reject) => {
      const signal = init?.signal
      const fail = () => reject(new DOMException('Aborted', 'AbortError'))
      if (signal?.aborted) {
        fail()
        return
      }
      signal?.addEventListener('abort', fail)
      // Never resolves on its own; only aborting settles it. `resolve` is kept
      // referenced so the "success" test can drive it directly.
      void resolve
    })
  }) as unknown as typeof fetch
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.stubGlobal('window', globalThis)
})

describe('fetchWithTimeout abort composition', () => {
  it('throws RequestAbortedError when the external signal aborts the in-flight request', async () => {
    vi.stubGlobal('fetch', abortAwareFetch())
    const controller = new AbortController()
    const promise = fetchWithTimeout('/x', undefined, 10_000, controller.signal)
    controller.abort()
    await expect(promise).rejects.toBeInstanceOf(RequestAbortedError)
  })

  it('aborts immediately when the external signal is already aborted', async () => {
    vi.stubGlobal('fetch', abortAwareFetch())
    const controller = new AbortController()
    controller.abort()
    await expect(fetchWithTimeout('/x', undefined, 10_000, controller.signal)).rejects.toBeInstanceOf(
      RequestAbortedError
    )
  })

  it('reports a timeout (not a cancel) when the internal deadline fires', async () => {
    vi.stubGlobal('fetch', abortAwareFetch())
    // No external signal; the 5ms internal timeout aborts the request.
    await expect(fetchWithTimeout('/x', undefined, 5)).rejects.toThrow('Request timed out')
  })

  it('resolves normally when neither the timeout nor the external signal fires', async () => {
    const response = new Response('ok')
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(response)) as unknown as typeof fetch
    )
    const controller = new AbortController()
    await expect(fetchWithTimeout('/x', undefined, 10_000, controller.signal)).resolves.toBe(response)
  })

  it('forwards the caller init while injecting the composed signal', async () => {
    const fetchMock = vi.fn(() => Promise.resolve(new Response('ok'))) as unknown as typeof fetch
    vi.stubGlobal('fetch', fetchMock)
    await fetchWithTimeout('/x', { method: 'POST' }, 10_000)
    const [, init] = (fetchMock as unknown as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(init.method).toBe('POST')
    expect(init.signal).toBeInstanceOf(AbortSignal)
  })
})
