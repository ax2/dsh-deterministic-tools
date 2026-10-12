import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { Envelope } from '../src/core/receipt.ts'
import { createTools, compileParameters } from '../src/tools.ts'
import { DEFAULT_LIMITS, resolveLimits, type Config } from '../src/limits.ts'

/** Every tool built with the default budgets. */
const tools = createTools({ limits: DEFAULT_LIMITS })

/** Look up a registered definition by name. */
function tool(name: string): ToolDefinition {
  const found = tools.find((candidate) => candidate.name === name)
  assert.ok(found, `tool ${name} is not registered`)
  return found
}

/** Execute a tool with a synthetic, always-live execution context. */
async function run(name: string, args: Record<string, unknown>): Promise<Envelope<Record<string, unknown>>> {
  const definition = tool(name)
  const value = (await definition.execute(args, { signal: new AbortController().signal } as never)) as Envelope<
    Record<string, unknown>
  >
  return value
}

/** Render a canonical value exactly as the registry would. */
function render(name: string, value: unknown): string {
  const definition = tool(name)
  const output = definition.output as { render?: (args: unknown, value: unknown) => { text: string }[] }
  const blocks = output.render?.({}, value) ?? []
  return blocks.map((block) => block.text).join('\n')
}

test('every tool declares a name, description, compiled schema, and receipt meta', () => {
  assert.equal(tools.length, 29)
  const names = new Set<string>()
  for (const definition of tools) {
    assert.equal(names.has(definition.name), false, `duplicate tool name ${definition.name}`)
    names.add(definition.name)
    assert.ok(definition.description.length > 40, `${definition.name} needs a real description`)
    const projected = definition.parameters as { type?: string; properties?: Record<string, unknown> }
    assert.equal(projected.type, 'object')
    assert.ok(projected.properties && Object.keys(projected.properties).length > 0, `${definition.name} has no parameters`)
    const output = definition.output as { schema?: { type?: string; properties?: Record<string, unknown> } }
    assert.equal(output.schema?.type, 'object')
    assert.deepEqual(Object.keys(output.schema?.properties ?? {}).sort(), ['meta', 'result'])
  }
})

test('the parameter DSL compiles to JSON Schema with required flags preserved', () => {
  const compiled = compileParameters({ text: { type: 'string', required: true }, level: { type: 'integer' } }) as {
    type: string
    properties: Record<string, { type: string }>
    required: string[]
  }
  assert.equal(compiled.type, 'object')
  assert.deepEqual(Object.keys(compiled.properties), ['text', 'level'])
  assert.equal(compiled.properties.text?.type, 'string')
  assert.deepEqual(compiled.required, ['text'])
})

test('json_format pretty-prints, sorts keys on request, and rejects invalid input', async () => {
  const plain = await run('json_format', { text: '{"b":1,"a":[1,2]}' })
  assert.equal(plain.result, '{\n  "b": 1,\n  "a": [\n    1,\n    2\n  ]\n}')
  assert.equal(plain.meta.truncated, false)
  assert.equal(plain.meta.bytesIn, 17)

  const sorted = await run('json_format', { text: '{"b":1,"a":2}', sort_keys: true })
  assert.equal(sorted.result, '{\n  "a": 2,\n  "b": 1\n}')
  assert.deepEqual(sorted.meta.notes, ['object keys sorted recursively'])

  await assert.rejects(() => run('json_format', { text: '{"a":}' }), /invalid JSON/)
})

test('json_validate reports a positioned error without throwing', async () => {
  const ok = await run('json_validate', { text: '[1,2,3]' })
  assert.deepEqual(ok.result, { valid: true, top_level_type: 'array' })

  const bad = await run('json_validate', { text: '{\n  "a": 1,\n  "b": ,\n}' })
  assert.equal(bad.result.valid, false)
  const error = bad.result.error as { line: number; column: number; position: number }
  assert.equal(error.line, 3)
  assert.ok(error.position > 0)
})

test('json_query walks paths and reports normalized matches', async () => {
  const doc = '{"items":[{"id":1},{"id":2}],"meta":{"id":9}}'
  const byIndex = await run('json_query', { text: doc, path: '$.items[1].id' })
  assert.deepEqual(byIndex.result, [{ path: '$.items[1].id', value: 2 }])

  const recursive = await run('json_query', { text: doc, path: '$..id' })
  assert.deepEqual(recursive.result, [
    { path: '$.items[0].id', value: 1 },
    { path: '$.items[1].id', value: 2 },
    { path: '$.meta.id', value: 9 },
  ])

  await assert.rejects(() => run('json_query', { text: doc, path: 'items[1]' }), /Unsupported path/)
})

test('json_diff reports JSON Pointer operations', async () => {
  const result = await run('json_diff', {
    left: '{"a":1,"b":2,"c":[1,2,3]}',
    right: '{"a":1,"b":3,"c":[1,2],"d":4}',
  })
  const differences = result.result.differences as { pointer: string; op: string }[]
  assert.deepEqual(
    differences.map((entry) => `${entry.op} ${entry.pointer}`),
    ['replace /b', 'remove /c/2', 'add /d'],
  )
  assert.equal(result.result.equal, false)

  const equal = await run('json_diff', { left: '{"a":1}', right: '{"a":1}' })
  assert.equal(equal.result.equal, true)
})

test('text_diff returns unified hunks with line numbers', async () => {
  const result = await run('text_diff', { left: 'a\nb\nc\n', right: 'a\nB\nc\n' })
  assert.equal(result.result.added, 1)
  assert.equal(result.result.removed, 1)
  assert.equal(result.result.coarse, false)
  const diff = String(result.result.diff)
  assert.match(diff, /^@@ -1,3 \+1,3 @@/m)
  assert.match(diff, /^-b$/m)
  assert.match(diff, /^\+B$/m)
})

test('lines_process and case_convert are deterministic', async () => {
  // 'b\na\nb\n\n' is four lines ('b', 'a', 'b', '') and ends with a terminator,
  // so dedupe keeps the empty last line and the trailing newline is reproduced.
  const deduped = await run('lines_process', { text: 'b\na\nb\n\n', op: 'dedupe' })
  assert.equal(deduped.result.text, 'b\na\n\n')
  assert.equal(deduped.result.lines_in, 4)
  assert.equal(deduped.result.lines_out, 3)
  assert.equal(deduped.result.trailing_newline, true)
  assert.equal(deduped.result.eol_in, 'lf')

  const noTrailer = await run('lines_process', { text: 'b\na\nb', op: 'dedupe' })
  assert.equal(noTrailer.result.text, 'b\na')
  assert.equal(noTrailer.result.trailing_newline, false)

  const crlf = await run('lines_process', { text: 'b\r\na\r\n', op: 'trim' })
  assert.equal(crlf.result.text, 'b\na\n')
  assert.equal(crlf.result.eol_in, 'crlf')
  assert.equal(crlf.result.trailing_newline, true)
  assert.ok((crlf.meta.notes as string[]).some((note) => note.includes('output uses LF')))

  const kebab = await run('case_convert', { text: 'HTTPServerConfig', mode: 'kebab' })
  assert.equal(kebab.result.text, 'http-server-config')
})

test('regex tools report groups, lines, and bound the haystack', async () => {
  const found = await run('regex_find', { text: 'id=1\nid=22\n', pattern: 'id=(?<n>\\d+)' })
  const matches = found.result.matches as { line: number; match: string; named: Record<string, string | null> }[]
  assert.equal(matches.length, 2)
  assert.equal(matches[1]!.line, 2)
  assert.equal(matches[1]!.named.n, '22')

  const replaced = await run('regex_replace', { text: 'a1 b2', pattern: '(\\w)(\\d)', replacement: '$2$1' })
  assert.equal(replaced.result.text, '1a 2b')
  assert.equal(replaced.result.replacements, 2)

  await assert.rejects(
    () => run('regex_find', { text: 'x'.repeat(70_000), pattern: 'x' }),
    /above the configured limit/,
  )
})

test('over-budget structured input is refused, never silently truncated', async () => {
  const small = resolveLimits({ maxInputBytes: 32 } satisfies Config)
  const limited = createTools({ limits: small, only: ['json_minify'] })
  assert.equal(limited.length, 1)
  await assert.rejects(
    () => limited[0]!.execute({ text: 'x'.repeat(64) }, { signal: new AbortController().signal } as never),
    /INPUT_TOO_LARGE|above the configured limit/,
  )
})

test('render emits the payload and only speaks up when something changed', async () => {
  const clean = await run('json_minify', { text: '{ "a": 1 }' })
  assert.equal(render('json_minify', clean), '{"a":1}')

  const noisy = await run('json_format', { text: '{"b":1,"a":2}', sort_keys: true })
  assert.match(render('json_format', noisy), /\[note\] object keys sorted recursively/)
})

test('tool names can be prefixed and filtered by the only list', () => {
  const prefixed = createTools({ limits: DEFAULT_LIMITS, prefix: 'zidev', only: ['json_minify', 'text_stats'] })
  assert.deepEqual(prefixed.map((definition) => definition.name), ['zidev__json_minify', 'zidev__text_stats'])
})


