/**
 * Differential and round-trip properties, driven by a fixed-seed PRNG so every
 * run is reproducible. These tests target the places where a hand-written
 * implementation could silently disagree with the platform: the JSON scanner vs
 * `JSON.parse`, and every encode/decode pair.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { scanJson } from '../src/core/json-scan.ts'
import { parseJson, serializeJson, sortKeysDeep } from '../src/core/json.ts'
import { convertBase } from '../src/core/inspect.ts'
import { base64Decode, base64Encode, hexDecode, hexEncode, urlDecode, urlEncode, URL_ENCODE_MODES } from '../src/core/encoding.ts'
import { parseCsv, toCsv } from '../src/core/data.ts'
import { processLines, splitLines } from '../src/core/text.ts'
import { convertTimestamp } from '../src/core/inspect.ts'

/** Deterministic 32-bit LCG (Numerical Recipes constants). */
function makeRandom(seed: number) {
  let state = seed >>> 0
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0
    return state / 0x1_0000_0000
  }
}

/** Parse text that the scanner already accepted. */
function parseValue(text: string): unknown {
  const result = parseJson(text)
  assert.equal(result.ok, true, `expected ${JSON.stringify(text)} to parse`)
  return result.ok ? result.value : undefined
}

test('the JSON scanner agrees with JSON.parse on generated and mutated documents', () => {
  const random = makeRandom(0x5eed_1234)
  const fragments = [
    '{"a":1}',
    '[1,2,3]',
    'null',
    'true',
    'false',
    '0',
    '-0.5e12',
    '"\\u00e9"',
    '{"nested":{"deep":[{"x":null}]}}',
    '[[[[1]]]]',
    '{"":""}',
    '1e309',
    '"\\ud83d\\ude00"',
    '{"a":1,}',
    '[1 2]',
    '{"a" "b"}',
    'NaN',
    'Infinity',
    'undefined',
    "'single'",
    '{"a":1}{"b":2}',
    '\u0000',
    '"unterminated',
    '{"a":[1,2}',
    '',
    '   ',
    '{"a": 1, "a": 2}',
  ]
  let checked = 0
  for (let round = 0; round < 400; round += 1) {
    let text = fragments[Math.floor(random() * fragments.length)]!
    // Randomly mutate a character so the corpus drifts into new shapes.
    if (random() < 0.5 && text.length > 0) {
      const index = Math.floor(random() * text.length)
      const chars = '{}[],:"\\0123456789.eE+-truefalsnu'
      text = text.slice(0, index) + chars[Math.floor(random() * chars.length)]! + text.slice(index + 1)
    }
    const scan = scanJson(text)
    let parsed: unknown
    let parseOk = true
    try {
      parsed = JSON.parse(text)
    } catch {
      parseOk = false
    }
    assert.equal(
      scan.ok,
      parseOk,
      `scanner and JSON.parse disagree on ${JSON.stringify(text)}: scanner=${JSON.stringify(scan)}`,
    )
    if (scan.ok) {
      // A successful scan must produce exactly the same value.
      assert.deepEqual(JSON.parse(JSON.stringify(JSON.parse(text))), JSON.parse(JSON.stringify(parsed)))
      assert.equal(JSON.stringify(parseValue(text)), JSON.stringify(parsed))
    } else {
      // A refusal must carry a position that actually points into the text.
      assert.ok(scan.line >= 1, 'line must be 1-based')
      assert.ok(scan.column >= 1, 'column must be 1-based')
      assert.ok(scan.position >= 0 && scan.position <= text.length, 'position must be inside the text')
    }
    checked += 1
  }
  assert.equal(checked, 400)
})

test('formatting any accepted JSON never changes its value and is idempotent', () => {
  const random = makeRandom(0xc0ffee)
  const literals: unknown[] = [
    { a: 1, b: [1, 2, { c: 'x' }] },
    [null, true, false, 0, -1.5, 'é', '\n', '\u0000'],
    { '': {}, 'weird key': [1, [2, [3]]] },
    1e21,
    'x'.repeat(100),
  ]
  for (let round = 0; round < 60; round += 1) {
    const value = literals[Math.floor(random() * literals.length)]!
    const once = serializeJson(value, 2, false)
    const twice = serializeJson(parseValue(once), 2, false)
    assert.equal(twice, once, 'formatting must be idempotent')
    assert.deepEqual(parseValue(once), JSON.parse(once))
    assert.deepEqual(sortKeysDeep(value), sortKeysDeep(sortKeysDeep(value)), 'key sorting must be idempotent')
  }
})

test('base64 and hex round-trip text and decode arbitrary bytes', () => {
  const random = makeRandom(0xbadc0de)
  const alphabet = [...'abc XYZ+/=?#\u00e9\u4e2d\u{1f600}']
  for (let round = 0; round < 120; round += 1) {
    // Text direction: these tools encode the UTF-8 bytes of their text input.
    let text = ''
    for (let index = 0, length = Math.floor(random() * 16); index < length; index += 1) {
      text += alphabet[Math.floor(random() * alphabet.length)]!
    }
    const utf8Hex = Buffer.from(text, 'utf8').toString('hex')
    assert.equal(base64Encode(text, false), Buffer.from(text, 'utf8').toString('base64'))
    assert.equal(base64Encode(text, true).includes('='), false, 'url-safe base64 must not be padded')
    assert.equal(base64Decode(base64Encode(text, false), false).buffer.toString('hex'), utf8Hex)
    assert.equal(base64Decode(base64Encode(text, true), true).buffer.toString('hex'), utf8Hex)
    assert.equal(hexEncode(text, false, ''), utf8Hex)
    assert.equal(hexEncode(text, true, ':'), utf8Hex.toUpperCase().replace(/(..)(?=.)/g, '$1:'))
    assert.equal(hexDecode(hexEncode(text, false, ':')).toString('hex'), utf8Hex)
    assert.equal(hexDecode(utf8Hex.toUpperCase()).toString('utf8'), text)
  }
  // Byte direction: decoding is purely byte-wise, whatever the payload is.
  for (let round = 0; round < 120; round += 1) {
    const bytes = Uint8Array.from({ length: Math.floor(random() * 64) }, () => Math.floor(random() * 256))
    const payload = Buffer.from(bytes)
    assert.equal(base64Decode(payload.toString('base64'), false).buffer.toString('hex'), payload.toString('hex'))
    assert.equal(hexDecode(payload.toString('hex')).toString('hex'), payload.toString('hex'))
  }
})

test('percent-encoding round-trips every mode', () => {
  const random = makeRandom(0xfeed)
  const alphabet = [...'abc XYZ?&=%+/\u00e9\u4e2d\u{1f600}#[]@!$']
  for (let round = 0; round < 120; round += 1) {
    let text = ''
    const length = Math.floor(random() * 12)
    for (let index = 0; index < length; index += 1) text += alphabet[Math.floor(random() * alphabet.length)]!
    for (const mode of URL_ENCODE_MODES) {
      const encoded = urlEncode(text, mode)
      const decoded = urlDecode(encoded, mode === 'form')
      assert.equal(decoded.text, text, `${mode} round-trip failed for ${JSON.stringify(text)}`)
      assert.equal(encoded.includes(' '), false, `${mode} must not leave raw spaces`)
      assert.equal(decoded.invalidSequences, 0)
    }
  }
})

test('percent-encoding refuses an unpaired surrogate with an actionable message', () => {
  assert.throws(() => urlEncode('a\uD83D', 'component'), /unpaired UTF-16 surrogate \(U\+D83D\) at index 1/)
  assert.throws(() => urlEncode('\uDE00', 'path'), /U\+DE00/)
  assert.equal(urlEncode('a\u{1f600}b', 'component'), 'a%F0%9F%98%80b')
})

test('CSV round-trips fields containing delimiters, quotes and newlines', () => {
  const random = makeRandom(0xabcdef)
  const pieces = ['a', 'b,c', 'd"e', 'f\ng', ' h ', '', '中', ';', '|', '\\', "''"]
  for (let round = 0; round < 120; round += 1) {
    const columns = ['c0', 'c1', 'c2']
    const records = Array.from({ length: 1 + Math.floor(random() * 4) }, () =>
      Object.fromEntries(columns.map((column) => [column, pieces[Math.floor(random() * pieces.length)]!])),
    )
    const csv = toCsv(records, columns, ',', '\n')
    const parsed = parseCsv(csv, { delimiter: ',', maxRecords: 100 })
    assert.deepEqual(parsed.rows[0], columns, 'the header row must be the column list')
    assert.deepEqual(
      parsed.rows.slice(1),
      records.map((record) => columns.map((column) => record[column])),
      `CSV round-trip failed for ${JSON.stringify(records)}`,
    )
    assert.equal(parsed.raggedRows, 0)
  }
})

test('number_base round-trips big integers through every base', () => {
  const random = makeRandom(0x1234_5678)
  for (let round = 0; round < 80; round += 1) {
    let value = 0n
    const digits = 1 + Math.floor(random() * 40)
    for (let index = 0; index < digits; index += 1) value = value * 10n + BigInt(Math.floor(random() * 10))
    if (random() < 0.4) value = -value
    const base = 2 + Math.floor(random() * 35)
    const rendered = convertBase(value.toString(), 10, base)
    const back = convertBase(rendered.value, base, 10)
    assert.equal(back.value, value.toString(), `base ${base} round-trip failed for ${value}`)
    assert.equal(rendered.negative, value < 0n)
  }
})

test('timestamp conversion round-trips epochs at second granularity', () => {
  const random = makeRandom(0x9999)
  for (let round = 0; round < 120; round += 1) {
    const seconds = Math.floor(random() * 4_000_000_000) - 1_000_000_000
    const info = convertTimestamp(String(seconds), 's', 0)
    const back = convertTimestamp(info.iso_utc, 'auto', 0)
    assert.equal(back.epoch_seconds, seconds, `timestamp round-trip failed for ${seconds}`)
    const offset = convertTimestamp(String(seconds), 's', 480)
    assert.equal(offset.epoch_seconds, seconds)
    assert.match(offset.iso_offset, /\+08:00$/)
  }
})

test('line operations are idempotent where they claim to be', () => {
  const random = makeRandom(0x2468)
  for (let round = 0; round < 60; round += 1) {
    const lines = Array.from({ length: Math.floor(random() * 12) }, () => 'x'.repeat(Math.floor(random() * 3)))
    const text = lines.join('\n') + (random() < 0.5 ? '\n' : '')
    for (const op of ['dedupe', 'trim', 'sort', 'compact'] as const) {
      // The same rendering rule the lines_process tool applies.
      const render = (input: string): string => {
        const processed = processLines(input, op).lines
        return processed.length === 0 ? '' : processed.join('\n') + (splitLines(input).trailingNewline ? '\n' : '')
      }
      const once = render(text)
      const twice = render(once)
      assert.equal(twice, once, `${op} must be idempotent (input ${JSON.stringify(text)})`)
    }
  }
})

