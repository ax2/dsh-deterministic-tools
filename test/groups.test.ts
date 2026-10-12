import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { Envelope } from '../src/core/receipt.ts'
import { createTools } from '../src/tools.ts'
import { DEFAULT_LIMITS, resolveLimits } from '../src/limits.ts'

const tools = createTools({ limits: DEFAULT_LIMITS })

/** Execute one tool through its registered definition. */
async function run(name: string, args: Record<string, unknown>, limits = DEFAULT_LIMITS): Promise<Envelope<Record<string, unknown>>> {
  const definition = tools.find((candidate) => candidate.name === name)
  assert.ok(definition, `tool ${name} is not registered`)
  const scoped = limits === DEFAULT_LIMITS ? definition : (createTools({ limits }).find((candidate) => candidate.name === name) as ToolDefinition)
  return (await scoped.execute(args, { signal: new AbortController().signal } as never)) as Envelope<Record<string, unknown>>
}

test('data group exposes YAML and CSV conversion with honest receipts', async () => {
  const yaml = await run('yaml_to_json', { text: 'a: 1\nb:\n  - x\n  - y\n' })
  assert.equal(yaml.result, '{\n  "a": 1,\n  "b": [\n    "x",\n    "y"\n  ]\n}')

  const back = await run('json_to_yaml', { text: '{"a":1,"b":[1,2]}' })
  assert.equal(back.result, 'a: 1\nb:\n  - 1\n  - 2\n')

  const csv = await run('csv_to_json', { text: 'name,age\nAda,36\nBob,41\n' })
  assert.deepEqual(csv.result.columns, ['name', 'age'])
  assert.deepEqual(csv.result.records, [
    { name: 'Ada', age: '36' },
    { name: 'Bob', age: '41' },
  ])
  assert.equal(csv.result.delimiter, ',')

  const quoted = await run('csv_to_json', { text: 'a,b\n"x,1","line\nbreak"\n' })
  assert.deepEqual(quoted.result.records, [{ a: 'x,1', b: 'line\nbreak' }])

  const out = await run('json_to_csv', { text: '[{"a":1,"b":"x,y"},{"a":2,"b":"z"}]' })
  assert.equal(out.result.csv, 'a,b\n1,"x,y"\n2,z')
  assert.deepEqual(out.result.columns, ['a', 'b'])
})

test('data group reports YAML errors with positions and refuses oversized input', async () => {
  await assert.rejects(() => run('yaml_to_json', { text: 'a: [1, 2\nb: 3' }), /invalid YAML/)
  await assert.rejects(() => run('json_to_csv', { text: '{"a":1}' }), /must be an array/)
  const tiny = resolveLimits({ maxInputBytes: 8 })
  await assert.rejects(() => run('yaml_to_json', { text: 'a: 1234567890' }, tiny), /above the configured limit/)
})

test('csv_to_json honours an explicit delimiter and reports ragged rows', async () => {
  const table = await run('csv_to_json', { text: 'a;b;c\n1;2\n', delimiter: ';' })
  assert.equal(table.result.delimiter, ';')
  assert.equal(table.result.ragged_rows, 1)
  assert.deepEqual(table.result.records, [{ a: '1', b: '2', c: '' }])
  assert.ok((table.meta.notes as string[]).some((note) => note.includes('different field count')))
})

test('encoding group round-trips base64, hex and percent-encoding', async () => {
  const encoded = await run('base64_encode', { text: 'hello' })
  assert.equal(encoded.result.base64, 'aGVsbG8=')
  const decoded = await run('base64_decode', { text: 'aGVsbG8=' })
  assert.deepEqual(
    { text: decoded.result.text, valid: decoded.result.valid_utf8, bytes: decoded.result.bytes },
    { text: 'hello', valid: true, bytes: 5 },
  )

  const urlSafe = await run('base64_encode', { text: 'ÿÿ', url_safe: true })
  assert.equal(urlSafe.result.base64, 'w7_Dvw')
  assert.equal(urlSafe.result.alphabet, 'url_safe')
  const urlSafeBack = await run('base64_decode', { text: 'w7_Dvw', url_safe: true })
  assert.equal(urlSafeBack.result.text, 'ÿÿ')

  await assert.rejects(() => run('base64_decode', { text: 'not base64!!' }), /not valid base64/)

  const hex = await run('hex_encode', { text: 'AB', separator: ':' })
  assert.equal(hex.result.hex, '41:42')
  const hexBack = await run('hex_decode', { text: '41 42' })
  assert.equal(hexBack.result.text, 'AB')
  await assert.rejects(() => run('hex_decode', { text: 'abc' }), /odd number of hex digits/)
})

test('encoding group reports lossy UTF-8 decoding instead of hiding it', async () => {
  const invalid = await run('base64_decode', { text: Buffer.from([0xff, 0xfe, 0x41]).toString('base64') })
  assert.equal(invalid.result.valid_utf8, false)
  assert.ok((invalid.meta.notes as string[]).some((note) => note.includes('not valid UTF-8')))
  assert.equal(invalid.result.hex_preview, 'fffe41')
})

test('url tools encode, decode, and inspect with warnings', async () => {
  const component = await run('url_encode', { text: 'a b&c', mode: 'component' })
  assert.equal(component.result.encoded, 'a%20b%26c')
  const form = await run('url_encode', { text: 'a b', mode: 'form' })
  assert.equal(form.result.encoded, 'a+b')
  const decoded = await run('url_decode', { text: 'a%20b%26c' })
  assert.equal(decoded.result.text, 'a b&c')
  const malformed = await run('url_decode', { text: '100%25 %zz' })
  assert.equal(malformed.result.invalid_sequences, 1)
  assert.match(String((malformed.meta.notes as string[]).join(' ')), /malformed percent sequence/)

  const inspected = await run('url_inspect', { url: 'http://user:pw@example.com:8080/a/b?x=1&y=2#frag' })
  assert.equal(inspected.result.scheme, 'http')
  assert.equal(inspected.result.host, 'example.com')
  assert.equal(inspected.result.port, '8080')
  assert.equal(inspected.result.path, '/a/b')
  assert.equal(inspected.result.hash, 'frag')
  assert.equal(inspected.result.has_password, true)
  assert.deepEqual(inspected.result.params, [
    { key: 'x', value: '1' },
    { key: 'y', value: '2' },
  ])
  assert.equal((inspected.result.warnings as string[]).length, 2)

  const relative = await run('url_inspect', { url: '/a/b', base: 'https://example.com/root/' })
  assert.equal(relative.result.href, 'https://example.com/a/b')
  assert.equal(relative.result.port, '443')
})

test('hash_text digests text and base64 payloads', async () => {
  const digest = await run('hash_text', { text: 'abc' })
  assert.equal(digest.result.digest, 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  assert.equal(digest.result.algorithm, 'sha256')
  assert.equal(digest.result.bytes, 3)

  const binary = await run('hash_text', { base64: Buffer.from([0x00, 0x01, 0x02]).toString('base64'), algorithm: 'md5' })
  assert.equal(binary.result.digest, 'b95f67f61ebb03619622d798f45fc2d3')
  // The registry validates arguments against the declared DSL before execute runs.
  await assert.rejects(() => run('hash_text', { text: 'x', algorithm: 'sha3' }), /must be one of/)
})

test('unicode_inspect reports code points, width and invisible characters', async () => {
  const result = await run('unicode_inspect', { text: 'a中\u200b' })
  const counts = result.result.counts as Record<string, number>
  assert.equal(counts.code_points, 3)
  assert.equal(counts.utf16_units, 3)
  assert.equal(counts.display_width, 3)
  assert.equal(counts.flagged, 1)
  assert.deepEqual(result.result.scripts, { Latin: 1, Han: 1, Common: 1 })
  const points = result.result.code_points as { code: string; width: number; flags: string[] }[]
  assert.equal(points[1]!.code, 'U+4E2D')
  assert.equal(points[1]!.width, 2)
  assert.deepEqual(points[2]!.flags, ['format', 'invisible'])

  const normalized = await run('unicode_inspect', { text: 'e\u0301', form: 'NFC' })
  const info = normalized.result.normalized as { form: string; changed: boolean; text: string }
  assert.equal(info.changed, true)
  assert.equal(info.text, 'é')
  assert.equal(info.form, 'NFC')

  const surrogate = await run('unicode_inspect', { text: '👍' })
  const surrogateCounts = surrogate.result.counts as Record<string, number>
  assert.equal(surrogateCounts.code_points, 1)
  assert.equal(surrogateCounts.utf8_bytes, 4)
})

test('number_base converts exactly, including big integers', async () => {
  assert.equal((await run('number_base', { text: '0xFF' })).result.decimal, '255')
  assert.equal((await run('number_base', { text: '255', from: '10', to: '16' })).result.value, 'ff')
  assert.equal((await run('number_base', { text: '-101', from: '2', to: '10' })).result.value, '-5')
  const big = await run('number_base', { text: '123456789012345678901234567890', from: '10', to: '16' })
  assert.equal(big.result.value, '18ee90ff6c373e0ee4e3f0ad2')
  await assert.rejects(() => run('number_base', { text: '12', from: '2', to: '10' }), /out of range for base 2/)
})

test('color_convert parses every literal form and computes contrast', async () => {
  const hex = await run('color_convert', { text: '#0a84ff' })
  assert.deepEqual([hex.result.r, hex.result.g, hex.result.b, hex.result.a], [10, 132, 255, 1])
  assert.equal(hex.result.hex, '#0a84ff')
  assert.ok(Number(hex.result.contrast_black) > Number(hex.result.contrast_white))

  const short = await run('color_convert', { text: '#f00' })
  assert.deepEqual([short.result.r, short.result.g, short.result.b], [255, 0, 0])
  assert.equal(short.result.hsl, 'hsl(0, 100%, 50%)')

  const rgba = await run('color_convert', { text: 'rgba(0, 0, 0, 0.5)' })
  assert.equal(rgba.result.hex_with_alpha, '#00000080')
  assert.equal(rgba.result.a, 0.5)

  const hsl = await run('color_convert', { text: 'hsl(211, 100%, 52%)' })
  assert.equal(hsl.result.r, 10)
  assert.equal(hsl.result.g, 129)
  await assert.rejects(() => run('color_convert', { text: 'rebeccapurple' }), /unsupported colour literal/)
})

test('cidr_inspect computes ranges and classifications', async () => {
  const v4 = await run('cidr_inspect', { text: '192.168.1.5/24' })
  assert.equal(v4.result.network, '192.168.1.0')
  assert.equal(v4.result.broadcast, '192.168.1.255')
  assert.equal(v4.result.first, '192.168.1.1')
  assert.equal(v4.result.last, '192.168.1.254')
  assert.equal(v4.result.total_addresses, '256')
  assert.equal(v4.result.usable_hosts, '254')
  assert.equal(v4.result.is_network_address, false)
  assert.deepEqual(v4.result.flags, ['private'])

  const host = await run('cidr_inspect', { text: '10.0.0.0/8' })
  assert.equal(host.result.is_network_address, true)
  assert.equal(host.result.total_addresses, '16777216')

  const v6 = await run('cidr_inspect', { text: '2001:db8::/32' })
  assert.equal(v6.result.family, 'ipv6')
  assert.equal(v6.result.total_addresses, '79228162514264337593543950336')
  assert.equal(v6.result.broadcast, null)
  await assert.rejects(() => run('cidr_inspect', { text: '10.0.0.0/33' }), /prefix must be an integer between 0 and 32/)
})

test('jwt_inspect decodes claims, states the verification gap, and never verifies', async () => {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url')
  const payload = Buffer.from(JSON.stringify({ sub: '1234', exp: 1_000_000_000, iat: 999_999_000 })).toString('base64url')
  const token = `${header}.${payload}.c2ln`
  const info = await run('jwt_inspect', { token, now: '2020-01-01T00:00:00Z' })
  assert.equal(info.result.alg, 'HS256')
  assert.equal(info.result.typ, 'JWT')
  assert.equal(info.result.signature_bytes, 3)
  assert.equal(info.result.expires_at, '2001-09-09T01:46:40.000Z')
  assert.equal(info.result.expired, true)
  assert.equal(info.result.evaluated_at, '2020-01-01T00:00:00.000Z')
  assert.match((info.result.warnings as string[]).join(' '), /NOT verified/)

  const none = await run('jwt_inspect', { token: `${Buffer.from('{"alg":"none"}').toString('base64url')}.${payload}.`, now: '2020-01-01T00:00:00Z' })
  assert.match((none.result.warnings as string[]).join(' '), /empty signature/)
})

test('timestamp_convert covers units, offsets and breakdowns', async () => {
  const seconds = await run('timestamp_convert', { value: '1700000000', unit: 'auto', offset_minutes: 480 })
  assert.equal(seconds.result.unit, 's')
  assert.equal(seconds.result.iso_utc, '2023-11-14T22:13:20.000Z')
  assert.equal(seconds.result.iso_offset, '2023-11-15T06:13:20.000+08:00')
  assert.equal(seconds.result.epoch_millis, 1_700_000_000_000)
  assert.equal(seconds.result.weekday, 'Tuesday')
  assert.equal(seconds.result.leap_year, false)

  const millis = await run('timestamp_convert', { value: '1700000000123', unit: 'auto' })
  assert.equal(millis.result.unit, 'ms')
  assert.equal(millis.result.iso_utc, '2023-11-14T22:13:20.123Z')

  const iso = await run('timestamp_convert', { value: '2024-02-29T00:00:00Z' })
  assert.equal(iso.result.unit, 'iso8601')
  assert.equal(iso.result.leap_year, true)
  assert.equal(iso.result.epoch_seconds, 1_709_164_800)

  await assert.rejects(() => run('timestamp_convert', { value: 'not a time' }), /neither an epoch value nor a parseable ISO 8601/)
})

test('over-budget output is clipped and marked instead of silently truncated', async () => {
  const limits = resolveLimits({ maxOutputBytes: 64 })
  const big = await run('base64_encode', { text: 'x'.repeat(200) }, limits)
  assert.equal(big.result.base64, Buffer.from('x'.repeat(200)).toString('base64'))
  assert.equal(big.meta.truncated, true)
  assert.ok((big.meta.notes as string[]).some((note) => note.includes('above maxOutputBytes')))
  const lines = await run('lines_process', { text: Array.from({ length: 50 }, (_, index) => `line-${index}`).join('\n'), op: 'number' }, limits)
  assert.equal(lines.meta.truncated, true)
  assert.ok((lines.meta.notes as string[]).some((note) => note.includes('clipped')))
})

