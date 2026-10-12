/**
 * DSH tool definitions. Each tool is a thin, declarative binding: a parameter
 * schema for the model, a boolean-bounded body, and the shared receipt renderer.
 * @module dsh-deterministic-tools/tools
 */
import {
  defineTool,
  parameterSchemaSpecToJsonSchema,
  type ParameterSchemaSpec,
  type ToolDefinition,
  type ValueSchemaSpec,
} from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { renderEnvelope, type Envelope } from './core/receipt.ts'
import { assertWithinInput, clipItems, clipToBytes, utf8Bytes } from './core/bytes.ts'
import {
  CASE_MODES,
  LINE_OPS,
  convertCase,
  diffLines,
  processLines,
  regexFind,
  regexReplace,
  splitLines,
  stats,
  toHunks,
  type CaseMode,
  type LineOp,
} from './core/text.ts'
import { diffJson, parseJson, queryJsonPath, serializeJson } from './core/json.ts'
import { DEFAULT_LIMITS, type Limits } from './limits.ts'
import { dataBodies } from './bodies/data.ts'
import { encodingBodies } from './bodies/encoding.ts'
import { inspectBodies } from './bodies/inspect.ts'

/** Tool groups, used by the `only` config filter and documentation. */
export type ToolGroup = 'json' | 'text' | 'encoding' | 'inspect' | 'data'

/** Shared meta schema for the receipt envelope. */
const META_SPEC = {
  type: 'object',
  additionalProperties: false,
  properties: {
    bytesIn: { type: 'integer', required: true, description: 'UTF-8 bytes read from the primary input.' },
    bytesOut: { type: 'integer', required: true, description: 'UTF-8 bytes of the canonical result.' },
    truncated: { type: 'boolean', required: true, description: 'True when a configured budget clipped input or output.' },
    notes: { type: 'array', items: { type: 'string' }, required: true, description: 'Ordered notes: budgets, fallbacks, unsupported syntax.' },
  },
} as const

/** Result schema slot for a body that does not declare one. */
const RESULT_SPEC = { type: 'json' } as const

/** One tool body: model-facing schema plus a bounded, synchronous implementation. */
export interface ToolBody {
  /** Tool name as the model sees it. */
  name: string
  /** Model-facing description; states the bounds and what the tool refuses. */
  description: string
  /** Parameter schema. */
  parameters: ParameterSchemaSpec
  /** Canonical result schema for the `result` field. */
  result: ValueSchemaSpec
  /** Group used by the `only` filter. */
  group: ToolGroup
  /** Implementation receiving validated arguments and the effective budgets. */
  run(args: Record<string, unknown>, limits: Limits): Envelope<JsonValue>
}

/**
 * Build a registry-ready definition with the shared receipt renderer.
 *
 * The registry validates the canonical value against the declared per-tool
 * `result` schema; only the author-facing generic is erased, because
 * `InferValue` collapses over a broad `ValueSchemaSpec` union. The pairing is
 * asserted by the tool tests instead.
 * @param body - tool body.
 * @param opts - budgets, name prefix, and allowlist for this plugin instance.
 */
export function defineReceiptTool(body: ToolBody, opts: ToolFactoryOptions) {
  const { limits, prefix = '' } = opts
  if (opts.only !== undefined && opts.only.length > 0 && !opts.only.includes(body.name)) return undefined
  const outputSchema = {
    type: 'object',
    additionalProperties: false,
    properties: { result: body.result ?? RESULT_SPEC, meta: META_SPEC },
  } as const
  const options = {
    name: prefix.length > 0 ? `${prefix}__${body.name}` : body.name,
    description: body.description,
    parameters: body.parameters,
    output: {
      schema: outputSchema,
      render: (_args: unknown, value: Envelope<unknown>) => renderEnvelope(value),
    },
    async execute(args: unknown, exec: { signal: AbortSignal }) {
      exec.signal.throwIfAborted()
      return guardOutputSize(body.run(args as Record<string, unknown>, limits), limits)
    },
  }
  // `defineTool`'s const generics recurse through `InferObject` over the broad
  // `ParameterSchemaSpec` union; the schema is still compiled and checked below,
  // so only the erased generic is dropped here.
  const compile = defineTool as unknown as (input: unknown) => ToolDefinition
  return compile(options)
}

/**
 * Flag a canonical payload that is larger than the configured output budget.
 *
 * Text payloads are clipped inside their own tool; a structured or encoded
 * payload cannot be partially clipped without becoming a different value, so it
 * is returned whole and marked instead of being silently mangled.
 * @param value - envelope produced by a tool body.
 * @param limits - effective budgets.
 */
function guardOutputSize(value: Envelope<JsonValue>, limits: Limits): Envelope<JsonValue> {
  const serialized = JSON.stringify(value.result) ?? ''
  const size = utf8Bytes(serialized)
  if (size <= limits.maxOutputBytes) return value
  return {
    result: value.result,
    meta: {
      ...value.meta,
      truncated: true,
      notes: [
        ...value.meta.notes,
        `result payload is ${size} bytes, above maxOutputBytes=${limits.maxOutputBytes}; it was returned whole because a canonical value cannot be partially clipped`,
      ],
    },
  }
}

/** Compile a parameter schema to JSON Schema, proving the DSL node is valid. */
export function compileParameters(spec: ParameterSchemaSpec) {
  return parameterSchemaSpecToJsonSchema(spec)
}

/** Clip a rendered text result and record the truncation in the notes. */
function boundedText(text: string, limits: Limits, notes: string[] = []): { text: string; truncated: boolean } {
  const clipped = clipToBytes(text, limits.maxOutputBytes)
  if (!clipped.truncated) return { text, truncated: false }
  notes.push(`output clipped to ${limits.maxOutputBytes} bytes (of ${utf8Bytes(text)} bytes); raise maxOutputBytes or narrow the request`)
  return { text: clipped.text, truncated: true }
}

const TEXT_INPUT = {
  type: 'string',
  required: true,
  description: 'Input document, passed inline.',
} as const

/** Options shared by every tool built for one plugin instance. */
export interface ToolFactoryOptions {
  /** Effective budgets. */
  limits: Limits
  /** Optional tool-name prefix, joined with `__`. */
  prefix?: string
  /** Register only these base tool names; empty registers every tool. */
  only?: readonly string[]
}

/**
 * Every tool this package registers, in registration order.
 * @param opts - budgets, name prefix, and optional allowlist.
 */
export function createTools(opts: ToolFactoryOptions) {
  const tools: (ReturnType<typeof defineReceiptTool>)[] = [
    // ---------------------------------------------------------------- json ---
    defineReceiptTool(
      {
        name: 'json_format',
        group: 'json',
        description:
          'Pretty-print a JSON document with a fixed indentation and optional recursive key sorting. Parses strictly and reports the exact line/column of the first syntax error instead of guessing.',
        parameters: {
          text: TEXT_INPUT,
          indent: { type: 'integer', description: 'Spaces per level (default 2, 0 compacts to one line).' },
          sort_keys: { type: 'boolean', description: 'Sort object keys recursively for byte-stable output.' },
        },
        result: { type: 'string' },
        run: (args, limits) => {
          const text = String(args.text)
          const bytesIn = assertWithinInput(text, limits.maxInputBytes)
          const parsed = parseJson(text)
          if (!parsed.ok) {
            throw new Error(
              `invalid JSON: ${parsed.error.message}` +
                (parsed.error.line === null ? '' : ` at line ${parsed.error.line}, column ${parsed.error.column}`),
            )
          }
          const indent = clampInt(args.indent, 2, 0, 10)
          const sorted = args.sort_keys === true
          const notes: string[] = []
          const { text: out, truncated } = boundedText(serializeJson(parsed.value, indent, sorted), limits, notes)
          if (sorted) notes.push('object keys sorted recursively')
          return { result: out, meta: { bytesIn, bytesOut: utf8Bytes(out), truncated, notes } }
        },
      },
      opts,
    ),
    defineReceiptTool(
      {
        name: 'json_minify',
        group: 'json',
        description: 'Compact a JSON document to a single line with no insignificant whitespace. Strict parse, positioned errors.',
        parameters: { text: TEXT_INPUT },
        result: { type: 'string' },
        run: (args, limits) => {
          const text = String(args.text)
          const bytesIn = assertWithinInput(text, limits.maxInputBytes)
          const parsed = parseJson(text)
          if (!parsed.ok) throw new Error(`invalid JSON: ${parsed.error.message}`)
          const notes: string[] = []
          const { text: out, truncated } = boundedText(serializeJson(parsed.value, 0, false), limits, notes)
          return { result: out, meta: { bytesIn, bytesOut: utf8Bytes(out), truncated, notes } }
        },
      },
      opts,
    ),
    defineReceiptTool(
      {
        name: 'json_validate',
        group: 'json',
        description:
          'Validate that a string is strict JSON and report the first error with line, column and character offset. Never throws on invalid input; a syntax error is a successful validation result.',
        parameters: { text: TEXT_INPUT },
        result: {
          type: 'object',
          additionalProperties: false,
          properties: {
            valid: { type: 'boolean', required: true },
            error: {
              type: 'object',
              additionalProperties: false,
              properties: {
                message: { type: 'string', required: true },
                line: { oneOf: [{ type: 'integer' }, { type: 'null' }] },
                column: { oneOf: [{ type: 'integer' }, { type: 'null' }] },
                position: { oneOf: [{ type: 'integer' }, { type: 'null' }] },
              },
            },
            top_level_type: { type: 'string', required: true, description: 'object, array, string, number, boolean or null.' },
          },
        },
        run: (args, limits) => {
          const text = String(args.text)
          const bytesIn = assertWithinInput(text, limits.maxInputBytes)
          const parsed = parseJson(text)
          if (parsed.ok) {
            return {
              result: { valid: true, top_level_type: typeOf(parsed.value) },
              meta: { bytesIn, bytesOut: 0, truncated: false, notes: [] },
            }
          }
          const result = {
            valid: false,
            error: {
              message: parsed.error.message,
              line: parsed.error.line,
              column: parsed.error.column,
              position: parsed.error.position,
            },
            top_level_type: 'unknown',
          }
          return {
            result,
            meta: { bytesIn, bytesOut: utf8Bytes(JSON.stringify(result)), truncated: false, notes: [] },
          }
        },
      },
      opts,
    ),
    defineReceiptTool(
      {
        name: 'json_query',
        group: 'json',
        description:
          "Query a JSON document with a bounded path subset: `$`, `.name`, `['name']`, `[0]`, `[*]` and `..name`. Returns each match with its normalized path. Unsupported syntax is refused, never silently ignored.",
        parameters: {
          text: TEXT_INPUT,
          path: { type: 'string', required: true, description: "Path such as `$.items[0].id` or `$..id`." },
        },
        result: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: { path: { type: 'string', required: true }, value: { type: 'json' } },
          },
        },
        run: (args, limits) => {
          const text = String(args.text)
          const bytesIn = assertWithinInput(text, limits.maxInputBytes)
          const parsed = parseJson(text)
          if (!parsed.ok) throw new Error(`invalid JSON: ${parsed.error.message}`)
          const { matches, truncated } = queryJsonPath(parsed.value, String(args.path), limits.maxMatches)
          const notes: string[] = []
          if (truncated) notes.push(`match count clipped to maxMatches=${limits.maxMatches}`)
          const result = matches as unknown as JsonValue
          return {
            result,
            meta: { bytesIn, bytesOut: utf8Bytes(JSON.stringify(matches)), truncated, notes },
          }
        },
      },
      opts,
    ),
    defineReceiptTool(
      {
        name: 'json_diff',
        group: 'json',
        description:
          'Compare two JSON documents and return ordered differences as JSON Pointers with before/after values. Ordered arrays compare by index; pass ignore_array_order to compare scalar arrays as multisets.',
        parameters: {
          left: { type: 'string', required: true, description: 'Original JSON document.' },
          right: { type: 'string', required: true, description: 'Revised JSON document.' },
          ignore_array_order: { type: 'boolean', description: 'Compare scalar arrays as multisets.' },
        },
        result: {
          type: 'object',
          additionalProperties: false,
          properties: {
            differences: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  pointer: { type: 'string', required: true },
                  op: { type: 'string', required: true, enum: ['add', 'remove', 'replace'] },
                  before: { type: 'json' },
                  after: { type: 'json' },
                },
              },
            },
            equal: { type: 'boolean', required: true },
          },
        },
        run: (args, limits) => {
          const leftText = String(args.left)
          const rightText = String(args.right)
          const bytesIn = assertWithinInput(leftText, limits.maxInputBytes, 'left') + assertWithinInput(rightText, limits.maxInputBytes, 'right')
          const left = parseJson(leftText)
          const right = parseJson(rightText)
          if (!left.ok) throw new Error(`invalid left JSON: ${left.error.message}`)
          if (!right.ok) throw new Error(`invalid right JSON: ${right.error.message}`)
          const { entries, truncated } = diffJson(left.value, right.value, limits.maxDiffEntries, args.ignore_array_order === true)
          const notes: string[] = []
          if (truncated) notes.push(`difference list clipped to maxDiffEntries=${limits.maxDiffEntries}`)
          const result = { differences: entries as unknown as JsonValue, equal: entries.length === 0 }
          return { result, meta: { bytesIn, bytesOut: utf8Bytes(JSON.stringify(result)), truncated, notes } }
        },
      },
      opts,
    ),

    // ---------------------------------------------------------------- text ---
    defineReceiptTool(
      {
        name: 'text_stats',
        group: 'text',
        description: 'Count bytes, UTF-16 characters, Unicode code points, lines, words, CJK characters and non-ASCII code points, and report the end-of-line style.',
        parameters: { text: TEXT_INPUT },
        result: {
          type: 'object',
          additionalProperties: false,
          properties: {
            bytes: { type: 'integer', required: true },
            characters: { type: 'integer', required: true },
            code_points: { type: 'integer', required: true },
            lines: { type: 'integer', required: true },
            words: { type: 'integer', required: true },
            cjk: { type: 'integer', required: true },
            non_ascii: { type: 'integer', required: true },
            eol: { type: 'string', required: true },
          },
        },
        run: (args, limits) => {
          const text = String(args.text)
          const bytesIn = assertWithinInput(text, limits.maxInputBytes)
          const s = stats(text)
          const result = {
            bytes: s.bytes,
            characters: s.characters,
            code_points: s.codePoints,
            lines: s.lines,
            words: s.words,
            cjk: s.cjk,
            non_ascii: s.nonAscii,
            eol: s.eol,
          }
          return { result, meta: { bytesIn, bytesOut: utf8Bytes(JSON.stringify(result)), truncated: false, notes: [] } }
        },
      },
      opts,
    ),
    defineReceiptTool(
      {
        name: 'lines_process',
        group: 'text',
        description:
          'Apply one deterministic line operation: dedupe (keeps first occurrence), trim, drop_empty, compact (collapse inner whitespace), sort, sort_desc, reverse or number. Reports how many lines were removed.',
        parameters: {
          text: TEXT_INPUT,
          op: { type: 'string', required: true, enum: LINE_OPS, description: 'Operation to apply.' },
        },
        result: {
          type: 'object',
          additionalProperties: false,
          properties: {
            text: { type: 'string', required: true },
            lines_in: { type: 'integer', required: true },
            lines_out: { type: 'integer', required: true },
          },
        },
        run: (args, limits) => {
          const text = String(args.text)
          const bytesIn = assertWithinInput(text, limits.maxInputBytes)
          const op = String(args.op) as LineOp
          const input = splitLines(text).lines.length
          const { lines } = processLines(text, op)
          const notes: string[] = []
          const { text: out, truncated } = boundedText(lines.join('\n'), limits, notes)
          const result = { text: out, lines_in: input, lines_out: lines.length }
          return { result, meta: { bytesIn, bytesOut: utf8Bytes(JSON.stringify(result)), truncated, notes } }
        },
      },
      opts,
    ),
    defineReceiptTool(
      {
        name: 'case_convert',
        group: 'text',
        description:
          'Convert an identifier or phrase into camel, pascal, snake, upper_snake, kebab, dot, title, lower or upper case. Word boundaries follow camelCase and acronym runs; non-alphanumeric separators split words.',
        parameters: {
          text: { type: 'string', required: true, description: 'Identifier or phrase to convert.' },
          mode: { type: 'string', required: true, enum: CASE_MODES, description: 'Target case style.' },
        },
        result: {
          type: 'object',
          additionalProperties: false,
          properties: { text: { type: 'string', required: true }, words: { type: 'array', items: { type: 'string' }, required: true } },
        },
        run: (args, limits) => {
          const text = String(args.text)
          const bytesIn = utf8Bytes(text)
          const mode = String(args.mode) as CaseMode
          const converted = convertCase(text, mode)
          const result = { text: converted, words: converted.split(/[^A-Za-z0-9]+/u).filter((w) => w.length > 0) }
          return { result, meta: { bytesIn, bytesOut: utf8Bytes(JSON.stringify(result)), truncated: false, notes: [] } }
        },
      },
      opts,
    ),
    defineReceiptTool(
      {
        name: 'text_diff',
        group: 'text',
        description:
          'Diff two documents by line and return unified-style hunks with line numbers. Exact LCS below the cell budget; larger pairs are coarsened to a common prefix/suffix plus one replaced block, and coarse=true says so.',
        parameters: {
          left: { type: 'string', required: true, description: 'Original document.' },
          right: { type: 'string', required: true, description: 'Revised document.' },
          context: { type: 'integer', description: 'Unchanged lines kept around each change (default 3).' },
        },
        result: {
          type: 'object',
          additionalProperties: false,
          properties: {
            diff: { type: 'string', required: true },
            added: { type: 'integer', required: true },
            removed: { type: 'integer', required: true },
            unchanged: { type: 'integer', required: true },
            coarse: { type: 'boolean', required: true },
          },
        },
        run: (args, limits) => {
          const left = String(args.left)
          const right = String(args.right)
          const bytesIn = assertWithinInput(left, limits.maxInputBytes, 'left') + assertWithinInput(right, limits.maxInputBytes, 'right')
          const diff = diffLines(left, right)
          const context = clampInt(args.context, 3, 0, 50)
          const hunks = toHunks(diff, context)
          const notes: string[] = []
          if (diff.coarse) notes.push('pair exceeded the exact LCS cell budget; middle block reported as a wholesale replacement')
          const rendered = hunks
            .map((hunk) => {
              const header = `@@ -${hunk.leftStart},${hunk.leftCount} +${hunk.rightStart},${hunk.rightCount} @@`
              return [header, ...hunk.lines.map((line) => `${line.op}${line.text}`)].join('\n')
            })
            .join('\n')
          const { text: out, truncated } = boundedText(rendered, limits, notes)
          const result = { diff: out, added: diff.added, removed: diff.removed, unchanged: diff.unchanged, coarse: diff.coarse }
          return { result, meta: { bytesIn, bytesOut: utf8Bytes(JSON.stringify(result)), truncated, notes } }
        },
      },
      opts,
    ),
    defineReceiptTool(
      {
        name: 'regex_find',
        group: 'text',
        description:
          'Find regular-expression matches with numbered and named capture groups, character offsets and 1-based line numbers. The haystack is capped at regexInputBytes because JavaScript backtracking cannot be preempted.',
        parameters: {
          text: TEXT_INPUT,
          pattern: { type: 'string', required: true, description: 'JavaScript regular-expression source.' },
          flags: { type: 'string', description: 'Flags from g, i, m, s, u, y, d (g is always applied).' },
        },
        result: {
          type: 'object',
          additionalProperties: false,
          properties: {
            matches: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  index: { type: 'integer', required: true },
                  line: { type: 'integer', required: true },
                  match: { type: 'string', required: true },
                  groups: { type: 'array', items: { oneOf: [{ type: 'string' }, { type: 'null' }] }, required: true },
                  named: { type: 'json' },
                },
              },
            },
            count: { type: 'integer', required: true },
          },
        },
        run: (args, limits) => {
          const text = String(args.text)
          const pattern = String(args.pattern)
          if (pattern.length > limits.maxPatternChars) {
            throw new Error(`pattern is ${pattern.length} characters, above maxPatternChars=${limits.maxPatternChars}`)
          }
          const bytesIn = assertWithinInput(text, Math.min(limits.maxInputBytes, limits.regexInputBytes), 'regex haystack')
          const { matches, truncated } = regexFind(text, pattern, String(args.flags ?? ''), {
            maxPatternChars: limits.maxPatternChars,
            maxMatches: limits.maxMatches,
          })
          const notes: string[] = []
          if (truncated) notes.push(`match list clipped to maxMatches=${limits.maxMatches}`)
          const result = { matches: matches as unknown as JsonValue, count: matches.length }
          return { result, meta: { bytesIn, bytesOut: utf8Bytes(JSON.stringify(result)), truncated, notes } }
        },
      },
      opts,
    ),
    defineReceiptTool(
      {
        name: 'regex_replace',
        group: 'text',
        description:
          'Replace regular-expression matches using $1/$<name> group references, bounded by maxMatches replacements. The haystack is capped at regexInputBytes.',
        parameters: {
          text: TEXT_INPUT,
          pattern: { type: 'string', required: true, description: 'JavaScript regular-expression source.' },
          replacement: { type: 'string', required: true, description: 'Replacement text; $1, $<name>, $$ and $& are supported.' },
          flags: { type: 'string', description: 'Flags from g, i, m, s, u, y, d (g is always applied).' },
        },
        result: {
          type: 'object',
          additionalProperties: false,
          properties: { text: { type: 'string', required: true }, replacements: { type: 'integer', required: true } },
        },
        run: (args, limits) => {
          const text = String(args.text)
          const pattern = String(args.pattern)
          if (pattern.length > limits.maxPatternChars) {
            throw new Error(`pattern is ${pattern.length} characters, above maxPatternChars=${limits.maxPatternChars}`)
          }
          const bytesIn = assertWithinInput(text, Math.min(limits.maxInputBytes, limits.regexInputBytes), 'regex haystack')
          const { text: out, replacements } = regexReplace(text, pattern, String(args.flags ?? ''), String(args.replacement), limits.maxMatches)
          const notes: string[] = []
          const bounded = boundedText(out, limits, notes)
          const result = { text: bounded.text, replacements }
          if (bounded.truncated) notes.unshift('replaced text clipped; the result is not a complete rewrite')
          return { result, meta: { bytesIn, bytesOut: utf8Bytes(JSON.stringify(result)), truncated: bounded.truncated, notes } }
        },
      },
      opts,
    ),
  ]
  const extra = [...dataBodies, ...encodingBodies, ...inspectBodies].map((body) => defineReceiptTool(body, opts))
  return [...tools, ...extra].filter((tool): tool is NonNullable<typeof tool> => tool !== undefined)
}

function typeOf(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  return typeof value
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.max(min, Math.min(max, Math.floor(value)))
}
