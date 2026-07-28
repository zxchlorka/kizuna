/**
 * Single shared entry point for "copy this text to the clipboard." Before this,
 * IndexInspectorView.tsx and KafkaMessageDetail.tsx each called
 * navigator.clipboard.writeText directly with their own try/catch, and neither
 * handled the case where the Clipboard API doesn't exist at all.
 *
 * navigator.clipboard is only exposed in a secure context (HTTPS, or
 * http://localhost). Kizuna's default bind is loopback, which is a secure
 * context, so this normally never matters. But KIZUNA_BIND=0.0.0.0 lets
 * someone open the app over plain http:// at a LAN address (see
 * docker-compose.yml's comment on that flag) — there, `navigator.clipboard` is
 * `undefined`, not a rejecting promise, so a bare `navigator.clipboard.writeText`
 * throws a TypeError before any network/permission concern even comes up.
 *
 * This falls back to the legacy `document.execCommand('copy')` path, which has
 * no secure-context requirement (it predates the Clipboard API and is still
 * broadly supported despite being deprecated). Only if that ALSO fails does the
 * caller get an honest "copy is unavailable" result to show the user — never a
 * silent no-op.
 */

export type ClipboardWriteResult =
  | { ok: true; method: 'clipboard-api' | 'exec-command' }
  | { ok: false; reason: 'unavailable' }

function hasClipboardApi(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    typeof navigator.clipboard !== 'undefined' &&
    typeof navigator.clipboard.writeText === 'function'
  )
}

function legacyCopy(text: string): boolean {
  if (typeof document === 'undefined' || typeof document.execCommand !== 'function') {
    return false
  }

  const textarea = document.createElement('textarea')
  textarea.value = text
  // Keep it out of the flow and off-screen rather than hidden: execCommand
  // requires the element to be focusable/selectable, which display:none or
  // visibility:hidden would prevent in some browsers.
  textarea.setAttribute('readonly', '')
  textarea.style.position = 'fixed'
  textarea.style.top = '0'
  textarea.style.left = '-9999px'
  document.body.appendChild(textarea)

  const previousFocus = document.activeElement as HTMLElement | null
  textarea.focus()
  textarea.select()

  let ok = false
  try {
    ok = document.execCommand('copy')
  } catch {
    ok = false
  }

  document.body.removeChild(textarea)
  previousFocus?.focus?.()
  return ok
}

export async function writeClipboardText(text: string): Promise<ClipboardWriteResult> {
  if (hasClipboardApi()) {
    try {
      await navigator.clipboard.writeText(text)
      return { ok: true, method: 'clipboard-api' }
    } catch {
      // Permission denied, or the call rejected for some other reason (seen in
      // practice when the document isn't focused). Fall through to the legacy
      // path rather than giving up.
    }
  }

  if (legacyCopy(text)) {
    return { ok: true, method: 'exec-command' }
  }

  return { ok: false, reason: 'unavailable' }
}

/** Human-readable message for a failed writeClipboardText — an honest reason,
 * not "something went wrong." */
export function clipboardFailureMessage(): string {
  return 'Clipboard is unavailable in this browser context (e.g. the app was opened over plain HTTP on a network address).'
}
