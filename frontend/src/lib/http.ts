const DEFAULT_TIMEOUT_MS = 8000

// The backend requires this header on every write. It is not a secret and grants
// nothing on its own: the point is that a page on another origin cannot set a
// custom header without a preflight, and the API answers no preflight. So a site
// the user did not open cannot post to their local Kizuna. Every API call must go
// through `apiFetch` or `fetchWithTimeout` for that guarantee to hold.
export const CLIENT_HEADER = 'X-Kizuna-Client'

function withClientHeader(init?: RequestInit): RequestInit {
  const headers = new Headers(init?.headers)
  headers.set(CLIENT_HEADER, '1')
  return { ...init, headers }
}

// Plain fetch for API calls that manage their own lifetime (long-running SQL,
// requests already wrapped in their own abort handling).
export function apiFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  return fetch(input, withClientHeader(init))
}

// Raised when a request is aborted through the caller-supplied `signal` (e.g. a
// user pressing "Cancel"), as opposed to the internal timeout firing. Callers
// can check for it to treat a deliberate cancel as a non-error instead of
// surfacing "Request timed out".
export class RequestAbortedError extends Error {
  constructor() {
    super('Request aborted.')
    this.name = 'RequestAbortedError'
  }
}

export async function fetchWithTimeout(
  input: RequestInfo | URL,
  init?: RequestInit,
  // Pass Infinity for requests that must never time out on their own (e.g. the
  // SQL console: legitimate queries can run 30-40s+, and a hard deadline there
  // is a deliberate non-feature, not an oversight). The external `signal` is
  // still fully composed in that case — it's the only thing that can abort the
  // request — so callers keep the RequestAbortedError classification below
  // instead of reimplementing it.
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
  // Optional external signal (e.g. a user "Cancel"). It is composed with the
  // internal timeout: whichever fires first aborts the underlying fetch. Done
  // by forwarding the external abort to the internal controller rather than via
  // AbortSignal.any(), so it works regardless of that API's availability in the
  // target browser.
  signal?: AbortSignal
): Promise<Response> {
  const controller = new AbortController()
  const timeout = Number.isFinite(timeoutMs) ? window.setTimeout(() => controller.abort(), timeoutMs) : undefined

  let onExternalAbort: (() => void) | undefined
  if (signal) {
    if (signal.aborted) {
      controller.abort()
    } else {
      onExternalAbort = () => controller.abort()
      signal.addEventListener('abort', onExternalAbort)
    }
  }

  try {
    return await fetch(input, {
      ...withClientHeader(init),
      signal: controller.signal,
    })
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      // An external cancel and the internal timeout both abort the same
      // controller; distinguish them by which signal is aborted so a user
      // cancel is not mislabeled as a timeout.
      if (signal?.aborted) {
        throw new RequestAbortedError()
      }
      throw new Error('Request timed out. Check the connection and try again.')
    }
    throw error
  } finally {
    if (timeout !== undefined) window.clearTimeout(timeout)
    if (onExternalAbort) signal?.removeEventListener('abort', onExternalAbort)
  }
}
