/**
 * Structured data conversion: YAML ↔ JSON and CSV ↔ JSON, with the same
 * bounded, receipt-carrying behaviour as the rest of the package.
 * @module dsh-deterministic-tools/core/data
 */
import { parseDocument, stringify as stringifyYaml } from 'yaml'
import { UnsupportedOptionError } from './bytes.ts'

/** Positioned YAML failure. */
export interface YamlFailure {
  /** Author-facing message. */
  message: string
  /** 1-based line, when the parser reports one. */
  line: number | null
  /** 1-based column, when the parser reports one. */
  column: number | null
}

/** YAML parse outcome. */
export type YamlParseResult = { ok: true; value: unknown; warnings: string[] } | { ok: false; error: YamlFailure; warnings: string[] }

/** Alias ceiling; blocks billion-laughs style expansion. */
export const MAX_YAML_ALIASES = 100

/**
 * Parse YAML into plain JSON data.
 * @param text - YAML document.
 */
export function parseYaml(text: string): YamlParseResult {
  const document = parseDocument(text, { prettyErrors: false })
  const warnings = document.warnings.map((warning) => warning.message)
  const firstError = document.errors[0]
  if (firstError !== undefined) {
    const position = firstError.linePos?.[0]
    return {
      ok: false,
      error: {
        message: firstError.message,
        line: position === undefined ? null : position.line,
        column: position === undefined ? null : position.col,
      },
      warnings,
    }
  }
  try {
    const value = document.toJS({ maxAliasCount: MAX_YAML_ALIASES }) as unknown
    return { ok: true, value, warnings }
  } catch (error) {
    return { ok: false, error: { message: error instanceof Error ? error.message : String(error), line: null, column: null }, warnings }
  }
}

/**
 * Serialize JSON data as YAML.
 * @param value - parsed data.
 * @param indent - spaces per level.
 * @param sortKeys - sort mapping keys for byte-stable output.
 */
export function toYaml(value: unknown, indent: number, sortKeys: boolean): string {
  return stringifyYaml(sortKeys ? sortDeep(value) : value, { indent: Math.max(1, Math.min(8, indent)), lineWidth: 0, aliasDuplicateObjects: false })
}

function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => sortDeep(item))
  if (value !== null && typeof value === 'object') {
    const source = value as Record<string, unknown>
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(source).sort()) out[key] = sortDeep(source[key])
    return out
  }
  return value
}

/** Delimiters the CSV detector considers. */
export const CSV_DELIMITERS = [',', ';', '\t', '|'] as const

/**
 * Guess the delimiter from the first few lines, ignoring quoted regions.
 * @param text - CSV document.
 */
export function detectDelimiter(text: string): string {
  const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0).slice(0, 5)
  let best = ','
  let bestScore = -1
  for (const delimiter of CSV_DELIMITERS) {
    const counts = lines.map((line) => countOutsideQuotes(line, delimiter))
    const first = counts[0] ?? 0
    if (first === 0) continue
    const consistent = counts.every((count) => count === first)
    const score = (consistent ? 1_000 : 0) + first
    if (score > bestScore) {
      bestScore = score
      best = delimiter
    }
  }
  return best
}

function countOutsideQuotes(line: string, delimiter: string): number {
  let count = 0
  let quoted = false
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i]!
    if (ch === '"') {
      if (quoted && line[i + 1] === '"') i += 1
      else quoted = !quoted
    } else if (!quoted && ch === delimiter) count += 1
  }
  return count
}

/** Parsed CSV table. */
export interface CsvTable {
  /** Rows of raw fields. */
  rows: string[][]
  /** Rows whose field count differs from the widest row. */
  raggedRows: number
  /** Whether the record ceiling clipped the table. */
  truncated: boolean
  /** Delimiter actually used. */
  delimiter: string
}

/**
 * Parse CSV with RFC 4180 quoting, embedded newlines, and a record ceiling.
 * @param text - CSV document.
 * @param options - delimiter (`auto` detects) and the record ceiling.
 */
export function parseCsv(text: string, options: { delimiter?: string; maxRecords: number }): CsvTable {
  const delimiter = options.delimiter === undefined || options.delimiter === 'auto' ? detectDelimiter(text) : options.delimiter
  if (delimiter.length !== 1) throw new UnsupportedOptionError('delimiter', delimiter, [...CSV_DELIMITERS, 'auto'])
  const rows: string[][] = []
  let field = ''
  let row: string[] = []
  let quoted = false
  let truncated = false
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i += 1
        } else quoted = false
      } else field += ch
      continue
    }
    if (ch === '"' && field.length === 0) {
      quoted = true
      continue
    }
    if (ch === delimiter) {
      row.push(field)
      field = ''
      continue
    }
    if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i += 1
      row.push(field)
      field = ''
      if (row.length > 1 || row[0] !== '') rows.push(row)
      row = []
      if (rows.length >= options.maxRecords) {
        truncated = true
        break
      }
      continue
    }
    field += ch
  }
  if (!truncated && (field.length > 0 || row.length > 0)) {
    row.push(field)
    if (row.length > 1 || row[0] !== '') rows.push(row)
  }
  const widest = rows.reduce((max, current) => Math.max(max, current.length), 0)
  const raggedRows = rows.filter((current) => current.length !== widest).length
  return { rows, raggedRows, truncated, delimiter }
}

/**
 * Turn a parsed table into records keyed by the header row.
 * @param table - parsed table.
 * @param hasHeader - treat the first row as the header.
 * @param maxRecords - record ceiling.
 */
export function tableToRecords(table: CsvTable, hasHeader: boolean, maxRecords: number): { columns: string[]; records: Record<string, string>[] } {
  if (!hasHeader) {
    const columns = Array.from({ length: table.rows.reduce((max, row) => Math.max(max, row.length), 0) }, (_, index) => `column_${index + 1}`)
    return { columns, records: table.rows.slice(0, maxRecords).map((row) => Object.fromEntries(columns.map((column, index) => [column, row[index] ?? '']))) }
  }
  const [header = [], ...body] = table.rows
  const columns = header.map((name, index) => (name.length > 0 ? name : `column_${index + 1}`))
  return {
    columns,
    records: body.slice(0, maxRecords).map((row) => Object.fromEntries(columns.map((column, index) => [column, row[index] ?? '']))),
  }
}

/** Characters that force a CSV field to be quoted. */
const NEEDS_QUOTES = /[",\r\n]/

/**
 * Serialize records or arrays as CSV.
 * @param rows - rows of scalar values.
 * @param columns - column order.
 * @param delimiter - field delimiter.
 * @param eol - line terminator.
 */
export function toCsv(rows: readonly Record<string, unknown>[], columns: readonly string[], delimiter: string, eol: string): string {
  const cell = (value: unknown): string => {
    if (value === null || value === undefined) return ''
    const text = typeof value === 'object' ? JSON.stringify(value) : String(value)
    return NEEDS_QUOTES.test(text) || text.includes(delimiter) ? `"${text.replaceAll('"', '""')}"` : text
  }
  const lines = [columns.map(cell).join(delimiter)]
  for (const row of rows) lines.push(columns.map((column) => cell(row[column])).join(delimiter))
  return lines.join(eol)
}
