/**
 * Packaging smoke test: load the built entry point exactly as the DSH loader
 * would and prove that `apply` registers every tool against a stub registry.
 *
 * Run after `pnpm build`:
 *   node scripts/smoke-built.mjs
 */
import assert from 'node:assert/strict'

const module = await import('../lib/index.js')

assert.equal(module.name, 'deterministic-tools', 'plugin name export is missing')
assert.deepEqual(module.inject, ['tools'], 'plugin must inject the tool registry')
assert.equal(typeof module.apply, 'function', 'plugin must export apply')
assert.ok(module.Config, 'plugin must export its Config schema')

const registered = []
const ctx = {
  tools: {
    register(definition) {
      registered.push(definition)
      return () => {}
    },
  },
}

module.apply(ctx, {})

assert.equal(registered.length, 29, `expected 29 tools, registered ${registered.length}`)
const names = registered.map((definition) => definition.name)
assert.equal(new Set(names).size, names.length, 'tool names must be unique')
for (const definition of registered) {
  assert.equal(typeof definition.name, 'string')
  assert.ok(definition.description.length > 40, `${definition.name} needs a real description`)
  assert.equal(typeof definition.execute, 'function')
  assert.equal(definition.output.schema.type, 'object')
}

const validate = registered.find((definition) => definition.name === 'json_validate')
const value = await validate.execute(
  { text: '{\n  "a": 1,\n  "b": ,\n}' },
  { signal: new AbortController().signal },
)
assert.equal(value.result.valid, false)
assert.equal(value.result.error.line, 3)
const blocks = validate.output.render({}, value)
assert.match(blocks[0].text, /"valid": false/)

// The `only` filter and prefix must compose the surface the user asked for.
const filtered = []
module.apply({ tools: { register: (definition) => (filtered.push(definition), () => {}) } }, { only: ['json_minify'], toolPrefix: 'zidev' })
assert.deepEqual(filtered.map((definition) => definition.name), ['zidev__json_minify'])

console.log(`smoke-built: ok — ${registered.length} tools registered from lib/index.js, json_validate reported line 3`)
