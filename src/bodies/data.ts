/**
 * Tool bodies for the data group: YAML ↔ JSON and CSV ↔ JSON.
 * @module dsh-deterministic-tools/bodies/data
 */
import { assertWithinInput, clipItems, utf8Bytes } from '../core/bytes.ts'
import { parseCsv, parseYaml, tableToRecords, toCsv, toYaml, CSV_DELIMITERS } from '../core/data.ts'
import { parseJson, serializeJson } from '../core/json.ts'
import type { ToolBody } from '../tools.ts'
import { TEXT_INPUT, boundedText } from './common.ts'

const DELIMITER_PARAM = {
  type: 'string',
  enum: ['auto', ...CSV_DELIMITERS],
  description: "Field delimiter; 'auto' detects from the first lines.",
} as const

/** YAML and CSV tool bodies. */
export const dataBodies: ToolBody[] = [
  {
    name: 'yaml_to_json',
    group: 'data',
    description:
      'Parse a YAML document and emit canonical JSON. Reports the first parse error with line and column, surfaces YAML warnings (duplicate keys), and refuses anchor/alias expansion beyond the alias budget.',
    parameters: { text: TEXT_INPUT, indent: { type: 'integer', description: 'Spaces per level in the JSON output (default 2).' } },
    result: { type: 'string' },
    run: (args, limits) => {
      const text = String(args.text)
      const bytesIn = assertWithinInput(text, limits.maxInputBytes)
      const parsed = parseYaml(text)
      if (!parsed.ok) {
        throw new Error(
          `invalid YAML: ${parsed.error.message}` +
            (parsed.error.line === null ? '' : ` at line ${parsed.error.line}, column ${parsed.error.column}`),
        )
      }
      const indent = typeof args.indent === 'number' ? Math.max(0, Math.min(10, Math.floor(args.indent))) : 2
      const notes = [...parsed.warnings]
      const { text: out, truncated } = boundedText(serializeJson(parsed.value ?? null, indent, false), limits, notes)
      return { result: out, meta: { bytesIn, bytesOut: utf8Bytes(out), truncated, notes } }
    },
  },
  {
    name: 'json_to_yaml',
    group: 'data',
    description:
      'Render a JSON document as YAML with a fixed indent and optional key sorting. Parses the JSON strictly first, so a syntax error is reported instead of half-written YAML.',
    parameters: {
      text: TEXT_INPUT,
      indent: { type: 'integer', description: 'Spaces per nesting level (default 2).' },
      sort_keys: { type: 'boolean', description: 'Sort mapping keys for byte-stable output.' },
    },
    result: { type: 'string' },
    run: (args, limits) => {
      const text = String(args.text)
      const bytesIn = assertWithinInput(text, limits.maxInputBytes)
      const parsed = parseJson(text)
      if (!parsed.ok) throw new Error(`invalid JSON: ${parsed.error.message}`)
      const indent = typeof args.indent === 'number' ? Math.max(1, Math.min(8, Math.floor(args.indent))) : 2
      const notes: string[] = []
      if (args.sort_keys === true) notes.push('mapping keys sorted recursively')
      const { text: out, truncated } = boundedText(toYaml(parsed.value, indent, args.sort_keys === true), limits, notes)
      return { result: out, meta: { bytesIn, bytesOut: utf8Bytes(out), truncated, notes } }
    },
  },
  {
    name: 'csv_to_json',
    group: 'data',
    description:
      "Parse CSV (RFC 4180 quoting, embedded newlines) into JSON records. Detects the delimiter unless one is given, uses the first row as the header unless has_header is false, and reports ragged rows and the record ceiling instead of hiding them.",
    parameters: {
      text: TEXT_INPUT,
      delimiter: DELIMITER_PARAM,
      has_header: { type: 'boolean', description: 'Treat the first row as the header (default true).' },
    },
    result: {
      type: 'object',
      additionalProperties: false,
      properties: {
        columns: { type: 'array', items: { type: 'string' }, required: true },
        records: { type: 'array', items: { type: 'json' }, required: true },
        row_count: { type: 'integer', required: true },
        ragged_rows: { type: 'integer', required: true },
        delimiter: { type: 'string', required: true },
      },
    },
    run: (args, limits) => {
      const text = String(args.text)
      const bytesIn = assertWithinInput(text, limits.maxInputBytes)
      const table = parseCsv(text, { delimiter: args.delimiter === undefined ? 'auto' : String(args.delimiter), maxRecords: limits.maxRecords })
      const hasHeader = args.has_header !== false
      const { columns, records } = tableToRecords(table, hasHeader, limits.maxRecords)
      const clipped = clipItems(records, limits.maxRecords)
      const notes: string[] = []
      if (table.raggedRows > 0) notes.push(`${table.raggedRows} row(s) had a different field count than the widest row; missing fields were filled with empty strings`)
      if (table.truncated || clipped.truncated) notes.push(`record list clipped to maxRecords=${limits.maxRecords}`)
      if (!hasHeader) notes.push('no header row: columns were synthesized as column_1..column_N')
      const result = {
        columns,
        records: clipped.items as unknown as never,
        row_count: table.rows.length,
        ragged_rows: table.raggedRows,
        delimiter: table.delimiter,
      }
      return {
        result,
        meta: {
          bytesIn,
          bytesOut: utf8Bytes(JSON.stringify(result)),
          truncated: table.truncated || clipped.truncated,
          notes,
        },
      }
    },
  },
  {
    name: 'json_to_csv',
    group: 'data',
    description:
      'Render a JSON array of objects (or of arrays) as CSV with RFC 4180 quoting. Columns default to the union of keys in first-seen order; nested values are serialized as compact JSON.',
    parameters: {
      text: TEXT_INPUT,
      delimiter: DELIMITER_PARAM,
      eol: { type: 'string', enum: ['\\n', '\\r\\n'], description: 'Line terminator (default \\n).' },
      columns: { type: 'array', items: { type: 'string' }, description: 'Explicit column order; defaults to the union of object keys.' },
    },
    result: {
      type: 'object',
      additionalProperties: false,
      properties: {
        csv: { type: 'string', required: true },
        columns: { type: 'array', items: { type: 'string' }, required: true },
        row_count: { type: 'integer', required: true },
      },
    },
    run: (args, limits) => {
      const text = String(args.text)
      const bytesIn = assertWithinInput(text, limits.maxInputBytes)
      const parsed = parseJson(text)
      if (!parsed.ok) throw new Error(`invalid JSON: ${parsed.error.message}`)
      if (!Array.isArray(parsed.value)) throw new Error('the JSON root must be an array of objects or of arrays')
      const rows = clipItems(parsed.value as unknown[], limits.maxRecords)
      const declared = Array.isArray(args.columns) ? (args.columns as string[]) : null
      const columns = declared ?? inferColumns(rows.items)
      const objects = rows.items.map((row) => (Array.isArray(row) ? Object.fromEntries(columns.map((column, index) => [column, row[index]])) : (row as Record<string, unknown>)))
      const delimiter = args.delimiter === undefined || args.delimiter === 'auto' ? ',' : String(args.delimiter)
      const eol = args.eol === '\\r\\n' ? '\r\n' : '\n'
      const notes: string[] = []
      if (rows.truncated) notes.push(`row list clipped to maxRecords=${limits.maxRecords}`)
      const notesOut: string[] = [...notes]
      const { text: csv, truncated } = boundedText(toCsv(objects, columns, delimiter, eol), limits, notesOut)
      const result = { csv, columns, row_count: rows.items.length }
      return { result, meta: { bytesIn, bytesOut: utf8Bytes(JSON.stringify(result)), truncated, notes: notesOut } }
    },
  },
]

function inferColumns(rows: readonly unknown[]): string[] {
  const columns: string[] = []
  const seen = new Set<string>()
  for (const row of rows) {
    if (row !== null && typeof row === 'object' && !Array.isArray(row)) {
      for (const key of Object.keys(row as Record<string, unknown>)) {
        if (!seen.has(key)) {
          seen.add(key)
          columns.push(key)
        }
      }
    }
  }
  if (columns.length === 0) {
    const width = rows.reduce<number>((max, row) => (Array.isArray(row) ? Math.max(max, row.length) : max), 0)
    for (let index = 0; index < width; index += 1) columns.push(`column_${index + 1}`)
  }
  return columns
}
