/**
 * Single shared entry point for "copy this text to the clipboard", so that a
 * failure always surfaces to the user instead of being a silent no-op. Before
 * this, callers each did their own try/catch and none handled the Clipboard API
 * being absent entirely.
 *
 * navigator.clipboard is exposed only in a secure context — HTTPS or
 * http://localhost. Both supported ways of running Kizuna are secure contexts:
 * the default bind is loopback, and the documented way to serve it further is
 * behind a TLS-terminating proxy (see docker-compose.yml). Outside them — an
 * operator setting KIZUNA_BIND=0.0.0.0 and browsing a plain-http LAN address —
 * `navigator.clipboard` is `undefined` rather than a rejecting promise, so it
 * is checked for rather than called blind, and the caller reports
 * clipboardFailureMessage() instead of appearing to have copied.
 */
export async function writeClipboardText(text: string): Promise<boolean> {
  if (typeof navigator === 'undefined' || typeof navigator.clipboard?.writeText !== 'function') {
    return false
  }

  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    // Permission denied, or the call rejected for another reason — seen in
    // practice when the document is not focused.
    return false
  }
}

/** Human-readable message for a failed writeClipboardText — an honest reason,
 * not "something went wrong." */
export function clipboardFailureMessage(): string {
  return 'Clipboard is unavailable in this browser context (e.g. the app was opened over plain HTTP on a network address).'
}
