// Значение линка выбирает пользователь: выделением мыши либо просто позицией
// курсора при вызове контекстного меню. Формат самого значения при этом не
// конфигурируется — вместо «чем разделено» описано «из чего значение состоит».
//
// SEPARATORS — символы, которых внутри указателя (UUID, числовой id, имя
// redis-ключа) не бывает. ':', '-', '.', '_' сюда сознательно НЕ входят: без
// них развалились бы и UUID, и ключи вида profile:123, которые сами бывают
// значениями линка.
const SEPARATORS = new Set([',', ';', '|', '/', '\\', ' ', '\t', '\n', '\r', '"', "'", '[', ']', '{', '}', '(', ')'])

// trimToken срезает разделители по краям — для выделения, в которое попала
// соседняя запятая или кавычка. Внутренние разделители не трогаются: если
// пользователь выделил кусок с запятой намеренно, он получит его как есть.
export function trimToken(raw: string): string {
  let start = 0
  let end = raw.length
  while (start < end && SEPARATORS.has(raw[start])) {
    start += 1
  }
  while (end > start && SEPARATORS.has(raw[end - 1])) {
    end -= 1
  }
  return raw.slice(start, end)
}

// tokenAt возвращает максимальный участок вокруг offset, не содержащий
// разделителей. Если offset попал на сам разделитель, вернётся токен слева.
export function tokenAt(text: string, offset: number): string {
  if (offset < 0 || offset > text.length) {
    return ''
  }
  let start = offset
  while (start > 0 && !SEPARATORS.has(text[start - 1])) {
    start -= 1
  }
  let end = offset
  while (end < text.length && !SEPARATORS.has(text[end])) {
    end += 1
  }
  return text.slice(start, end)
}

// caretOffsetAt — единственное место, зависящее от DOM API. Стандартный
// caretPositionFromPoint есть в Firefox, WebKit/Blink дают caretRangeFromPoint.
function caretOffsetAt(clientX: number, clientY: number): { node: Node; offset: number } | null {
  const doc = document as Document & {
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null
    caretRangeFromPoint?: (x: number, y: number) => Range | null
  }
  if (typeof doc.caretPositionFromPoint === 'function') {
    const position = doc.caretPositionFromPoint(clientX, clientY)
    return position ? { node: position.offsetNode, offset: position.offset } : null
  }
  if (typeof doc.caretRangeFromPoint === 'function') {
    const range = doc.caretRangeFromPoint(clientX, clientY)
    return range ? { node: range.startContainer, offset: range.startOffset } : null
  }
  return null
}

// valueAtPoint — то, что подставится в линк. Выделение приоритетнее токена:
// это страховка на нестандартный формат, где фиксированный набор разделителей
// обрежет не там. Учитывается только выделение внутри container (кликнутой
// строки), чтобы выделение в соседней ячейке не утекло в значение.
export function valueAtPoint(clientX: number, clientY: number, container: Node | null): string | null {
  const selection = window.getSelection()
  if (
    selection &&
    !selection.isCollapsed &&
    container &&
    selection.anchorNode &&
    container.contains(selection.anchorNode)
  ) {
    const selected = trimToken(selection.toString())
    if (selected !== '') {
      return selected
    }
  }

  const caret = caretOffsetAt(clientX, clientY)
  if (!caret || caret.node.nodeType !== Node.TEXT_NODE) {
    return null
  }
  if (container && !container.contains(caret.node)) {
    return null
  }
  const token = tokenAt(caret.node.textContent ?? '', caret.offset)
  return token === '' ? null : token
}
