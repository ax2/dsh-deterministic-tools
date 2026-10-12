/**
 * Deterministic text operations: statistics, line processing, case conversion,
 * escaping, regular expressions, and a bounded line diff.
 * @module dsh-deterministic-tools/core/text
 */
import { UnsupportedOptionError, utf8Bytes } from './bytes.ts'

/** Mixed EOL style observed in the input. */
export type EolStyle = 'lf' | 'crlf' | 'cr' | 'mixed' | 'none'

/** Result of splitting a document into lines. */
export interface SplitText {
  /** Lines without terminators. A trailing newline does not add an empty line. */
  lines: string[]
  /** Dominant end-of-line style, or `mixed`/`none`. */
  eol: EolStyle
}

/**
 * Split text into lines while recording the EOL style.
 * @param text - source document.
 * @returns lines plus the observed EOL style.
 */
export function splitLines(text: string): SplitText {
  if (text.length === 0) return { lines: [], eol: 'none' }
  const hasCrlf = text.includes('\r\n')
  const withoutCrlf = hasCrlf ? text.replaceAll('\r\n', '\n') : text
  const hasCr = withoutCrlf.includes('\r')
  const hasLf = withoutCrlf.includes('\n')
  const eol: EolStyle = hasCrlf && !hasCr ? 'crlf' : hasCr && hasLf ? 'mixed' : hasCr ? 'cr' : hasLf ? 'lf' : 'none'
  const normalized = withoutCrlf.replaceAll('\r', '\n')
  const lines = normalized.split('\n')
  if (lines.length > 0 && lines[lines.length - 1] === '' && /\r?\n$|\r$/.test(text)) lines.pop()
  return { lines, eol }
}

/** Text statistics for one document. */
export interface TextStats {
  /** UTF-8 bytes. */
  bytes: number
  /** UTF-16 code units (`String.length`). */
  characters: number
  /** Unicode code points (surrogate pairs counted once). */
  codePoints: number
  /** Line count using the input's own separators. */
  lines: number
  /** Whitespace-separated tokens. */
  words: number
  /** CJK ideographs, kana, and Hangul syllables. */
  cjk: number
  /** Code points outside the Basic Latin block. */
  nonAscii: number
  /** Observed end-of-line style. */
  eol: EolStyle
}

/**
 * Compute statistics for a document.
 * @param text - source document.
 */
export function stats(text: string): TextStats {
  const split = splitLines(text)
  const codePoints = [...text].length
  let cjk = 0
  let nonAscii = 0
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0
    if (cp > 0x7f) nonAscii += 1
    if (
      (cp >= 0x3040 && cp <= 0x30ff) ||
      (cp >= 0x3400 && cp <= 0x4dbf) ||
      (cp >= 0x4e00 && cp <= 0x9fff) ||
      (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0xac00 && cp <= 0xd7af)
    ) {
      cjk += 1
    }
  }
  const words = text.trim().length === 0 ? 0 : text.trim().split(/\s+/u).length
  return { bytes: utf8Bytes(text), characters: text.length, codePoints, lines: split.lines.length, words, cjk, nonAscii, eol: split.eol }
}

/** Case conversion modes. */
export const CASE_MODES = ['camel', 'pascal', 'snake', 'upper_snake', 'kebab', 'dot', 'title', 'lower', 'upper'] as const
/** One case conversion mode. */
export type CaseMode = (typeof CASE_MODES)[number]

/**
 * Split an identifier or phrase into lowercase word tokens.
 * @param text - source identifier or phrase.
 * @returns word tokens in source order.
 */
export function tokenizeWords(text: string): string[] {
  return text
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/u)
    .filter((token) => token.length > 0)
    .map((token) => token.toLowerCase())
}

/**
 * Convert an identifier or phrase into one case style.
 * @param text - source text.
 * @param mode - target style.
 */
export function convertCase(text: string, mode: CaseMode): string {
  if (mode === 'lower') return text.toLowerCase()
  if (mode === 'upper') return text.toUpperCase()
  const words = tokenizeWords(text)
  if (words.length === 0) return ''
  switch (mode) {
    case 'camel':
      return words[0]! + words.slice(1).map(capitalize).join('')
    case 'pascal':
      return words.map(capitalize).join('')
    case 'snake':
      return words.join('_')
    case 'upper_snake':
      return words.join('_').toUpperCase()
    case 'kebab':
      return words.join('-')
    case 'dot':
      return words.join('.')
    case 'title':
      return words.map(capitalize).join(' ')
    default:
      throw new UnsupportedOptionError('mode', mode, CASE_MODES)
  }
}

function capitalize(word: string): string {
  return word.length === 0 ? word : word[0]!.toUpperCase() + word.slice(1)
}

/** Line processing operations. */
export const LINE_OPS = ['dedupe', 'trim', 'drop_empty', 'sort', 'sort_desc', 'reverse', 'number', 'compact'] as const
/** One line processing operation. */
export type LineOp = (typeof LINE_OPS)[number]

/**
 * Apply one line operation. Order is preserved except for the explicit sort and
 * reverse operations; dedupe keeps the first occurrence.
 * @param text - source document.
 * @param op - operation to apply.
 * @returns processed lines plus how many lines were dropped.
 */
export function processLines(text: string, op: LineOp): { lines: string[]; removed: number } {
  const { lines } = splitLines(text)
  const before = lines.length
  let out: string[]
  switch (op) {
    case 'dedupe': {
      const seen = new Set<string>()
      out = lines.filter((line) => (seen.has(line) ? false : (seen.add(line), true)))
      break
    }
    case 'trim':
      out = lines.map((line) => line.trim())
      break
    case 'drop_empty':
      out = lines.filter((line) => line.trim().length > 0)
      break
    case 'compact':
      out = lines.map((line) => line.replace(/[ \t]+/gu, ' ').trim()).filter((line) => line.length > 0)
      break
    case 'sort':
      out = [...lines].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
      break
    case 'sort_desc':
      out = [...lines].sort((a, b) => (a < b ? 1 : a > b ? -1 : 0))
      break
    case 'reverse':
      out = [...lines].reverse()
      break
    case 'number':
      out = lines.map((line, index) => `${index + 1}\t${line}`)
      break
    default:
      throw new UnsupportedOptionError('op', op, LINE_OPS)
  }
  return { lines: out, removed: Math.max(0, before - out.length) }
}

/** HTML escape table (the five characters that change HTML parsing). */
const HTML_ESCAPES: ReadonlyArray<readonly [RegExp, string]> = [
  [/&/g, '&amp;'],
  [/</g, '&lt;'],
  [/>/g, '&gt;'],
  [/"/g, '&quot;'],
  [/'/g, '&#39;'],
]

/**
 * Escape HTML-significant characters.
 * @param text - source text.
 */
export function htmlEscape(text: string): string {
  let out = text
  for (const [pattern, replacement] of HTML_ESCAPES) out = out.replace(pattern, replacement)
  return out
}

/**
 * Reverse {@link htmlEscape}, including numeric character references.
 * @param text - escaped text.
 */
export function htmlUnescape(text: string): string {
  return text
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, hex: string) => safeFromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_m, dec: string) => safeFromCodePoint(Number.parseInt(dec, 10)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, '\u00a0')
    .replace(/&amp;/g, '&')
}

function safeFromCodePoint(value: number): string {
  if (!Number.isFinite(value) || value < 0 || value > 0x10ffff) return '\ufffd'
  return String.fromCodePoint(value)
}

/**
 * Escape control characters as `\n`, `\t`, `\\`, `\uXXXX`.
 * @param text - source text.
 */
export function stringEscape(text: string): string {
  return JSON.stringify(text)
    .slice(1, -1)
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029')
}

/**
 * Reverse {@link stringEscape}. Unknown escapes are kept verbatim so no input is
 * silently invented or dropped.
 * @param text - escaped text.
 * @returns decoded text and the escapes that were not recognised.
 */
export function stringUnescape(text: string): { text: string; unknownEscapes: string[] } {
  const unknown = new Set<string>()
  const decoded = text.replace(/\\(u\{[0-9a-fA-F]+\}|u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|.)/g, (_m, body: string) => {
    if (body.startsWith('u{')) return safeFromCodePoint(Number.parseInt(body.slice(2, -1), 16))
    if (body.startsWith('u')) return safeFromCodePoint(Number.parseInt(body.slice(1), 16))
    if (body.startsWith('x')) return safeFromCodePoint(Number.parseInt(body.slice(1), 16))
    switch (body) {
      case 'n':
        return '\n'
      case 'r':
        return '\r'
      case 't':
        return '\t'
      case 'b':
        return '\b'
      case 'f':
        return '\f'
      case 'v':
        return '\v'
      case '0':
        return '\0'
      case '\\':
        return '\\'
      case '"':
        return '"'
      case "'":
        return "'"
      case '/':
        return '/'
      default:
        unknown.add(`\\${body}`)
        return `\\${body}`
    }
  })
  return { text: decoded, unknownEscapes: [...unknown].sort() }
}

/** One regular-expression match. */
export interface RegexMatch {
  /** Zero-based match index in the input. */
  index: number
  /** The whole match. */
  match: string
  /** Numbered capture groups; unmatched groups are `null`. */
  groups: (string | null)[]
  /** Named capture groups. */
  named: Record<string, string | null>
  /** 1-based line of the match start. */
  line: number
}

/** Guard rails for regular-expression tools. */
export interface RegexLimits {
  /** Hard ceiling on the pattern length. */
  maxPatternChars: number
  /** Hard ceiling on matches returned. */
  maxMatches: number
}

/**
 * Run a regular expression and return bounded, line-annotated matches.
 * @param text - haystack.
 * @param pattern - source pattern.
 * @param flags - `g`, `i`, `m`, `s`, `u`, `y` (the `g` flag is always applied).
 * @param limits - pattern and match ceilings.
 */
export function regexFind(text: string, pattern: string, flags: string, limits: RegexLimits): { matches: RegexMatch[]; truncated: boolean; flagsUsed: string } {
  const normalized = sanitizeFlags(flags)
  const re = new RegExp(pattern, normalized)
  const lineStarts = computeLineStarts(text)
  const matches: RegexMatch[] = []
  let truncated = false
  for (const m of text.matchAll(re)) {
    if (matches.length >= limits.maxMatches) {
      truncated = true
      break
    }
    matches.push({
      index: m.index ?? 0,
      match: m[0],
      groups: m.slice(1).map((group) => group ?? null),
      named: { ...(m.groups ?? {}) },
      line: lineOf(lineStarts, m.index ?? 0),
    })
  }
  return { matches, truncated, flagsUsed: normalized }
}

/**
 * Replace regular-expression matches with a bounded rewrite.
 * @param text - haystack.
 * @param pattern - source pattern.
 * @param flags - regex flags (the `g` flag is always applied).
 * @param replacement - replacement using `$1`-style group references.
 * @param maxReplacements - ceiling on replacements performed.
 * @returns rewritten text and the number of replacements applied.
 */
export function regexReplace(text: string, pattern: string, flags: string, replacement: string, maxReplacements: number): { text: string; replacements: number; truncated: boolean } {
  const re = new RegExp(pattern, sanitizeFlags(flags))
  let count = 0
  const out = text.replace(re, (...args: unknown[]) => {
    if (count >= maxReplacements) return args[0] as string
    count += 1
    return expandReplacement(replacement, args)
  })
  const capped = count >= maxReplacements && re.test(text)
  return { text: out, replacements: count, truncated: capped }
}

function sanitizeFlags(flags: string): string {
  const allowed = new Set(['g', 'i', 'm', 's', 'u', 'y', 'd'])
  const seen = new Set<string>()
  for (const flag of flags) {
    if (!allowed.has(flag)) throw new UnsupportedOptionError('flags', flag, [...allowed])
    seen.add(flag)
  }
  seen.add('g')
  return [...seen].join('')
}

function expandReplacement(template: string, args: unknown[]): string {
  const groups = args.slice(1, -2) as (string | undefined)[]
  const named = args[args.length - 1] as Record<string, string> | undefined
  return template
    .replace(/\$(\$|&|`|'|\d{1,2}|<[^>]+>)/g, (_m, token: string) => {
      if (token === '$') return '$'
      if (token === '&') return (args[0] as string) ?? ''
      if (token.startsWith('<')) return named?.[token.slice(1, -1)] ?? ''
      const index = Number.parseInt(token, 10)
      if (Number.isNaN(index)) return token
      return groups[index - 1] ?? ''
    })
}

function computeLineStarts(text: string): number[] {
  const starts = [0]
  for (let i = 0; i < text.length; i += 1) if (text[i] === '\n') starts.push(i + 1)
  return starts
}

function lineOf(starts: readonly number[], index: number): number {
  let low = 0
  let high = starts.length - 1
  while (low < high) {
    const mid = Math.ceil((low + high) / 2)
    if (starts[mid]! <= index) low = mid
    else high = mid - 1
  }
  return low + 1
}

/** One diff line: context, removal, or addition. */
export interface DiffLine {
  /** ` ` context, `-` removal, `+` addition. */
  op: ' ' | '-' | '+'
  /** Line text without terminator. */
  text: string
  /** 1-based line number in the left document, absent for additions. */
  left?: number
  /** 1-based line number in the right document, absent for removals. */
  right?: number
}

/** Bounded line-diff result. */
export interface LineDiff {
  /** Diff lines in document order. */
  lines: DiffLine[]
  /** Added line count. */
  added: number
  /** Removed line count. */
  removed: number
  /** Unchanged line count. */
  unchanged: number
  /** True when the pair was too large for exact matching and was coarsened. */
  coarse: boolean
}

/** Cell budget for exact LCS matching (default 4,000,000). */
export const DEFAULT_DIFF_CELL_BUDGET = 4_000_000

/**
 * Diff two documents by line.
 *
 * Exact LCS below the cell budget; above it the pair is reduced to a common
 * prefix/suffix plus one replaced middle block, and `coarse` is set so callers
 * can say so instead of pretending the diff is minimal.
 * @param left - original document.
 * @param right - revised document.
 * @param cellBudget - maximum LCS matrix cells before coarsening.
 */
export function diffLines(left: string, right: string, cellBudget: number = DEFAULT_DIFF_CELL_BUDGET): LineDiff {
  const a = splitLines(left).lines
  const b = splitLines(right).lines
  let prefix = 0
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix += 1
  let suffix = 0
  while (suffix < a.length - prefix && suffix < b.length - prefix && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]) suffix += 1
  const aMid = a.slice(prefix, a.length - suffix)
  const bMid = b.slice(prefix, b.length - suffix)
  const lines: DiffLine[] = []
  for (let i = 0; i < prefix; i += 1) lines.push({ op: ' ', text: a[i]!, left: i + 1, right: i + 1 })

  let coarse = false
  if (aMid.length * bMid.length > cellBudget) {
    coarse = true
    aMid.forEach((text, i) => lines.push({ op: '-', text, left: prefix + i + 1 }))
    bMid.forEach((text, i) => lines.push({ op: '+', text, right: prefix + i + 1 }))
  } else {
    lines.push(...lcsDiff(aMid, bMid, prefix, prefix))
  }
  for (let i = 0; i < suffix; i += 1) {
    const leftIndex = a.length - suffix + i
    const rightIndex = b.length - suffix + i
    lines.push({ op: ' ', text: a[leftIndex]!, left: leftIndex + 1, right: rightIndex + 1 })
  }
  const added = lines.filter((line) => line.op === '+').length
  const removed = lines.filter((line) => line.op === '-').length
  return { lines, added, removed, unchanged: lines.length - added - removed, coarse }
}

function lcsDiff(a: readonly string[], b: readonly string[], leftOffset: number, rightOffset: number): DiffLine[] {
  const rows = a.length + 1
  const cols = b.length + 1
  const table = new Uint32Array(rows * cols)
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      table[i * cols + j] = a[i] === b[j] ? table[(i + 1) * cols + j + 1]! + 1 : Math.max(table[(i + 1) * cols + j]!, table[i * cols + j + 1]!)
    }
  }
  const out: DiffLine[] = []
  let i = 0
  let j = 0
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ op: ' ', text: a[i]!, left: leftOffset + i + 1, right: rightOffset + j + 1 })
      i += 1
      j += 1
    } else if (table[(i + 1) * cols + j]! >= table[i * cols + j + 1]!) {
      out.push({ op: '-', text: a[i]!, left: leftOffset + i + 1 })
      i += 1
    } else {
      out.push({ op: '+', text: b[j]!, right: rightOffset + j + 1 })
      j += 1
    }
  }
  while (i < a.length) {
    out.push({ op: '-', text: a[i]!, left: leftOffset + i + 1 })
    i += 1
  }
  while (j < b.length) {
    out.push({ op: '+', text: b[j]!, right: rightOffset + j + 1 })
    j += 1
  }
  return out
}

/**
 * Group diff lines into hunks with a context window, unified-diff style.
 * @param diff - line diff.
 * @param context - unchanged lines kept around each change.
 * @returns hunks in document order.
 */
export function toHunks(diff: LineDiff, context = 3): { leftStart: number; leftCount: number; rightStart: number; rightCount: number; lines: DiffLine[] }[] {
  const changed = diff.lines.map((line, index) => (line.op === ' ' ? -1 : index)).filter((index) => index >= 0)
  if (changed.length === 0) return []
  const ranges: [number, number][] = []
  let start = Math.max(0, changed[0]! - context)
  let end = Math.min(diff.lines.length - 1, changed[0]! + context)
  for (const index of changed.slice(1)) {
    if (index - context <= end + 1) end = Math.min(diff.lines.length - 1, index + context)
    else {
      ranges.push([start, end])
      start = Math.max(0, index - context)
      end = Math.min(diff.lines.length - 1, index + context)
    }
  }
  ranges.push([start, end])
  return ranges.map(([from, to]) => {
    const lines = diff.lines.slice(from, to + 1)
    const leftLines = lines.filter((line) => line.op !== '+')
    const rightLines = lines.filter((line) => line.op !== '-')
    return {
      leftStart: leftLines[0]?.left ?? 1,
      leftCount: leftLines.length,
      rightStart: rightLines[0]?.right ?? 1,
      rightCount: rightLines.length,
      lines,
    }
  })
}
