/**
 * A strict, positioned JSON scanner.
 *
 * `JSON.parse` reports positions only for some error shapes on modern V8; this
 * scanner always knows the exact offset, line, and column of the first failure,
 * and its accept/reject decision is kept in parity with `JSON.parse` by tests.
 * @module dsh-deterministic-tools/core/json-scan
 */

/** A positioned syntax failure produced by the scanner. */
export interface ScanFailure {
  /** Author-facing description of the first failure. */
  message: string
  /** 0-based character offset. */
  position: number
  /** 1-based line. */
  line: number
  /** 1-based column. */
  column: number
}

/** Scanner outcome. */
export type ScanResult = { ok: true } | ({ ok: false } & ScanFailure)

const WHITESPACE = new Set([' ', '\t', '\n', '\r'])
const ESCAPES = new Set(['"', '\\', '/', 'b', 'f', 'n', 'r', 't', 'u'])

/**
 * Validate a JSON document and locate the first syntax error exactly.
 * @param text - candidate document.
 */
export function scanJson(text: string): ScanResult {
  let index = 0

  const fail = (message: string, at: number = index): ScanResult => {
    const position = Math.max(0, Math.min(at, text.length))
    let line = 1
    let lastBreak = -1
    for (let cursor = 0; cursor < position; cursor += 1) {
      if (text[cursor] === '\n') {
        line += 1
        lastBreak = cursor
      }
    }
    return { ok: false, message, position, line, column: position - lastBreak }
  }

  const skipWhitespace = (): void => {
    while (index < text.length && WHITESPACE.has(text[index]!)) index += 1
  }

  const scanString = (): ScanResult => {
    const start = index
    index += 1
    while (index < text.length) {
      const ch = text[index]!
      if (ch === '"') {
        index += 1
        return { ok: true }
      }
      if (ch === '\\') {
        index += 1
        if (index >= text.length) return fail('unterminated escape sequence')
        const escape = text[index]!
        if (!ESCAPES.has(escape)) return fail(`invalid escape sequence \\${escape}`, index - 1)
        if (escape === 'u') {
          const hex = text.slice(index + 1, index + 5)
          if (hex.length < 4 || !/^[0-9a-fA-F]{4}$/.test(hex)) return fail('invalid \\u escape: four hex digits are required', index - 1)
          index += 4
        }
        index += 1
        continue
      }
      if (ch.codePointAt(0)! < 0x20) return fail('unescaped control character in string', index)
      index += 1
    }
    return fail('unterminated string', start)
  }

  const scanNumber = (): ScanResult => {
    const start = index
    if (text[index] === '-') index += 1
    if (index >= text.length) return fail('incomplete number', start)
    if (text[index] === '0') {
      index += 1
    } else if (/[1-9]/.test(text[index]!)) {
      while (index < text.length && /[0-9]/.test(text[index]!)) index += 1
    } else {
      return fail('invalid number', start)
    }
    if (text[index] === '.') {
      index += 1
      if (!/[0-9]/.test(text[index] ?? '')) return fail('a decimal point needs at least one digit after it', start)
      while (index < text.length && /[0-9]/.test(text[index]!)) index += 1
    }
    if (text[index] === 'e' || text[index] === 'E') {
      index += 1
      if (text[index] === '+' || text[index] === '-') index += 1
      if (!/[0-9]/.test(text[index] ?? '')) return fail('an exponent needs at least one digit', start)
      while (index < text.length && /[0-9]/.test(text[index]!)) index += 1
    }
    return { ok: true }
  }

  const scanValue = (): ScanResult => {
    skipWhitespace()
    if (index >= text.length) return fail('unexpected end of input; a value is required')
    const ch = text[index]!
    if (ch === '{') return scanObject()
    if (ch === '[') return scanArray()
    if (ch === '"') return scanString()
    if (ch === '-' || /[0-9]/.test(ch)) return scanNumber()
    if (text.startsWith('true', index)) {
      index += 4
      return { ok: true }
    }
    if (text.startsWith('false', index)) {
      index += 5
      return { ok: true }
    }
    if (text.startsWith('null', index)) {
      index += 4
      return { ok: true }
    }
    return fail(`unexpected token '${ch}'`)
  }

  function scanObject(): ScanResult {
    index += 1
    skipWhitespace()
    if (text[index] === '}') {
      index += 1
      return { ok: true }
    }
    for (;;) {
      skipWhitespace()
      if (index >= text.length) return fail('unexpected end of input inside an object')
      if (text[index] !== '"') return fail(`expected a double-quoted property name but found '${text[index]}'`)
      const key = scanString()
      if (!key.ok) return key
      skipWhitespace()
      if (text[index] !== ':') return fail(`expected ':' after the property name but found ${describe(text[index])}`)
      index += 1
      const value = scanValue()
      if (!value.ok) return value
      skipWhitespace()
      if (text[index] === ',') {
        index += 1
        continue
      }
      if (text[index] === '}') {
        index += 1
        return { ok: true }
      }
      return fail(`expected ',' or '}' after a property value but found ${describe(text[index])}`)
    }
  }

  function scanArray(): ScanResult {
    index += 1
    skipWhitespace()
    if (text[index] === ']') {
      index += 1
      return { ok: true }
    }
    for (;;) {
      const value = scanValue()
      if (!value.ok) return value
      skipWhitespace()
      if (text[index] === ',') {
        index += 1
        continue
      }
      if (text[index] === ']') {
        index += 1
        return { ok: true }
      }
      return fail(`expected ',' or ']' after an array element but found ${describe(text[index])}`)
    }
  }

  const document = scanValue()
  if (!document.ok) return document
  skipWhitespace()
  if (index < text.length) return fail(`unexpected trailing content '${text[index]}' after the top-level value`)
  return { ok: true }
}

function describe(ch: string | undefined): string {
  return ch === undefined ? 'end of input' : `'${ch}'`
}
