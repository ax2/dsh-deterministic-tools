/**
 * Deterministic JSON operations: strict parsing with positions, formatting,
 * minification, JSONPath subset queries, and a structured JSON diff.
 * @module dsh-deterministic-tools/core/json
 */
import { UnsupportedOptionError } from './bytes.ts'
import { scanJson } from './json-scan.ts'

/** A positioned JSON parse failure. */
export interface JsonParseError {
  /** Parser message, trimmed of engine-specific decoration. */
  message: string
  /** 1-based line of the failure, when the engine reports a position. */
  line: number | null
  /** 1-based column of the failure, when the engine reports a position. */
  column: number | null
  /** 0-based character offset, when the engine reports a position. */
  position: number | null
}

/** Result of a strict JSON parse. */
export type JsonParseResult = { ok: true; value: unknown } | { ok: false; error: JsonParseError }

/**
 * Parse JSON and report a positioned failure instead of throwing.
 *
 * The position comes from the local scanner, not from the engine's message
 * shape, so every syntax error reports line, column, and offset.
 * @param text - candidate JSON document.
 */
export function parseJson(text: string): JsonParseResult {
  const scan = scanJson(text)
  if (!scan.ok) {
    return { ok: false, error: { message: scan.message, line: scan.line, column: scan.column, position: scan.position } }
  }
  return { ok: true, value: JSON.parse(text) as unknown }
}

/**
 * Convert a character offset into a 1-based line/column pair.
 * @param text - document.
 * @param offset - 0-based character offset.
 */
export function locate(text: string, offset: number): { line: number; column: number } {
  const clamped = Math.max(0, Math.min(offset, text.length))
  let line = 1
  let lastBreak = -1
  for (let i = 0; i < clamped; i += 1) {
    if (text[i] === '\n') {
      line += 1
      lastBreak = i
    }
  }
  return { line, column: clamped - lastBreak }
}

/**
 * Recursively sort object keys so formatting is byte-stable.
 * @param value - parsed JSON value.
 */
export function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => sortKeysDeep(item))
  if (value !== null && typeof value === 'object') {
    const source = value as Record<string, unknown>
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(source).sort()) out[key] = sortKeysDeep(source[key])
    return out
  }
  return value
}

/**
 * Serialize a parsed value with a deterministic layout.
 * @param value - parsed JSON value.
 * @param indent - spaces per level, 0 for a single line.
 * @param sortKeys - sort object keys recursively.
 */
export function serializeJson(value: unknown, indent: number, sortKeys: boolean): string {
  const target = sortKeys ? sortKeysDeep(value) : value
  if (indent <= 0) return JSON.stringify(target) ?? 'null'
  return JSON.stringify(target, null, indent) ?? 'null'
}

/** One JSONPath query match. */
export interface JsonPathMatch {
  /** Normalized path to the match, e.g. `$.items[0].id`. */
  path: string
  /** Matched value. */
  value: unknown
}

/**
 * Query a parsed document with a bounded JSONPath subset:
 * `$`, `.name`, `['name']`, `[0]`, `[*]`, and `..name` recursive descent.
 * @param root - parsed JSON value.
 * @param expression - JSONPath expression.
 * @param maxMatches - ceiling on returned matches.
 * @returns matches and whether the ceiling clipped them.
 */
export function queryJsonPath(root: unknown, expression: string, maxMatches: number): { matches: JsonPathMatch[]; truncated: boolean } {
  const tokens = parseJsonPath(expression)
  let current: JsonPathMatch[] = [{ path: '$', value: root }]
  for (const token of tokens) {
    const next: JsonPathMatch[] = []
    for (const node of current) {
      if (token.kind === 'key') {
        if (isPlainObject(node.value) && token.name! in (node.value as Record<string, unknown>)) {
          next.push({ path: `${node.path}.${token.name!}`, value: (node.value as Record<string, unknown>)[token.name!] })
        }
      } else if (token.kind === 'index') {
        if (Array.isArray(node.value)) {
          const index = token.index! < 0 ? node.value.length + token.index! : token.index!
          if (index >= 0 && index < node.value.length) next.push({ path: `${node.path}[${index}]`, value: node.value[index] })
        }
      } else if (token.kind === 'wildcard') {
        if (Array.isArray(node.value)) node.value.forEach((item, index) => next.push({ path: `${node.path}[${index}]`, value: item }))
        else if (isPlainObject(node.value)) for (const key of Object.keys(node.value)) next.push({ path: `${node.path}.${key}`, value: (node.value as Record<string, unknown>)[key] })
      } else {
        descend(node, token.name!, next)
      }
    }
    current = next
    if (current.length === 0) break
  }
  if (current.length > maxMatches) return { matches: current.slice(0, maxMatches), truncated: true }
  return { matches: current, truncated: false }
}

function descend(node: JsonPathMatch, name: string, out: JsonPathMatch[]): void {
  if (isPlainObject(node.value)) {
    const record = node.value as Record<string, unknown>
    for (const key of Object.keys(record)) {
      if (key === name) out.push({ path: `${node.path}.${key}`, value: record[key] })
      descend({ path: `${node.path}.${key}`, value: record[key] }, name, out)
    }
  } else if (Array.isArray(node.value)) {
    node.value.forEach((item, index) => descend({ path: `${node.path}[${index}]`, value: item }, name, out))
  }
}

interface PathToken {
  kind: 'key' | 'index' | 'wildcard' | 'recursive'
  name?: string
  index?: number
}

function parseJsonPath(expression: string): PathToken[] {
  const trimmed = expression.trim()
  if (trimmed !== '$' && !trimmed.startsWith('$')) {
    throw new UnsupportedOptionError('path', expression, ['$', '$.a.b', "$['a'][0]", '$.a[*]', '$..name'])
  }
  const tokens: PathToken[] = []
  let rest = trimmed.slice(1)
  while (rest.length > 0) {
    if (rest.startsWith('..')) {
      const match = /^\.\.([A-Za-z_$][\w$]*)/.exec(rest)
      if (!match) throw new UnsupportedOptionError('path', expression, ['$..name'])
      tokens.push({ kind: 'recursive', name: match[1]! })
      rest = rest.slice(match[0].length)
    } else if (rest.startsWith('.')) {
      const match = /^\.([A-Za-z_$][\w$]*)/.exec(rest)
      if (!match) throw new UnsupportedOptionError('path', expression, ['$.name'])
      tokens.push({ kind: 'key', name: match[1]! })
      rest = rest.slice(match[0].length)
    } else if (rest.startsWith('[')) {
      const end = rest.indexOf(']')
      if (end < 0) throw new UnsupportedOptionError('path', expression, ["['name']", '[0]', '[*]'])
      const inner = rest.slice(1, end).trim()
      if (inner === '*') tokens.push({ kind: 'wildcard' })
      else if (/^-?\d+$/.test(inner)) tokens.push({ kind: 'index', index: Number.parseInt(inner, 10) })
      else {
        const quoted = /^(['"])(.*)\1$/.exec(inner)
        if (!quoted) throw new UnsupportedOptionError('path', expression, ["['name']", '[0]', '[*]'])
        tokens.push({ kind: 'key', name: quoted[2]! })
      }
      rest = rest.slice(end + 1)
    } else {
      throw new UnsupportedOptionError('path', expression, ['$.a', "$['a']", '$.a[0]', '$..a'])
    }
  }
  return tokens
}

/** One structured difference between two JSON documents. */
export interface JsonDiffEntry {
  /** JSON Pointer to the affected location. */
  pointer: string
  /** Operation kind. */
  op: 'add' | 'remove' | 'replace'
  /** Value on the left side, absent for `add`. */
  before?: unknown
  /** Value on the right side, absent for `remove`. */
  after?: unknown
}

/**
 * Compute a structured, ordered diff between two JSON documents.
 * @param left - parsed left document.
 * @param right - parsed right document.
 * @param maxEntries - ceiling on reported differences.
 * @param ignoreArrayOrder - compare arrays of scalars as multisets.
 * @returns ordered differences and whether the ceiling clipped them.
 */
export function diffJson(
  left: unknown,
  right: unknown,
  maxEntries: number,
  ignoreArrayOrder = false,
): { entries: JsonDiffEntry[]; truncated: boolean } {
  const entries: JsonDiffEntry[] = []
  walk(left, right, '', entries, ignoreArrayOrder, maxEntries)
  if (entries.length > maxEntries) return { entries: entries.slice(0, maxEntries), truncated: true }
  return { entries, truncated: false }
}

function walk(left: unknown, right: unknown, pointer: string, out: JsonDiffEntry[], ignoreArrayOrder: boolean, limit: number): void {
  if (out.length > limit) return
  if (isPlainObject(left) && isPlainObject(right)) {
    const l = left as Record<string, unknown>
    const r = right as Record<string, unknown>
    for (const key of Object.keys(l).sort()) {
      const child = `${pointer}/${escapePointer(key)}`
      if (!(key in r)) out.push({ pointer: child, op: 'remove', before: l[key] })
      else walk(l[key], r[key], child, out, ignoreArrayOrder, limit)
    }
    for (const key of Object.keys(r).sort()) {
      if (!(key in l)) out.push({ pointer: `${pointer}/${escapePointer(key)}`, op: 'add', after: r[key] })
    }
    return
  }
  if (Array.isArray(left) && Array.isArray(right)) {
    if (ignoreArrayOrder && left.every(isScalar) && right.every(isScalar)) {
      const leftSet = new Map<string, number>()
      for (const item of left) leftSet.set(JSON.stringify(item), (leftSet.get(JSON.stringify(item)) ?? 0) + 1)
      const rightSet = new Map<string, number>()
      for (const item of right) rightSet.set(JSON.stringify(item), (rightSet.get(JSON.stringify(item)) ?? 0) + 1)
      for (const [key, count] of leftSet) {
        const other = rightSet.get(key) ?? 0
        if (other < count) out.push({ pointer: `${pointer}/-`, op: 'remove', before: JSON.parse(key) as unknown })
      }
      for (const [key, count] of rightSet) {
        const other = leftSet.get(key) ?? 0
        if (other < count) out.push({ pointer: `${pointer}/-`, op: 'add', after: JSON.parse(key) as unknown })
      }
      return
    }
    const max = Math.max(left.length, right.length)
    for (let index = 0; index < max; index += 1) {
      const child = `${pointer}/${index}`
      if (index >= left.length) out.push({ pointer: child, op: 'add', after: right[index] })
      else if (index >= right.length) out.push({ pointer: child, op: 'remove', before: left[index] })
      else walk(left[index], right[index], child, out, ignoreArrayOrder, limit)
    }
    return
  }
  if (!deepEqual(left, right)) out.push({ pointer: pointer === '' ? '' : pointer, op: 'replace', before: left, after: right })
}

function escapePointer(token: string): string {
  return token.replaceAll('~', '~0').replaceAll('/', '~1')
}

function isScalar(value: unknown): boolean {
  return value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Structural JSON equality (`-0` and `0` compare equal, key order is ignored).
 * @param left - first value.
 * @param right - second value.
 */
export function deepEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true
  if (typeof left === 'number' && typeof right === 'number') return left === right || (Number.isNaN(left) && Number.isNaN(right))
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((item, index) => deepEqual(item, right[index]))
  }
  if (isPlainObject(left) && isPlainObject(right)) {
    const keys = Object.keys(left)
    if (keys.length !== Object.keys(right).length) return false
    return keys.every((key) => key in right && deepEqual(left[key], right[key]))
  }
  return false
}
