/**
 * Tool bodies for the inspect group: Unicode, number bases, colours, CIDR, JWT
 * structure, and timestamps.
 * @module dsh-deterministic-tools/bodies/inspect
 */
import { assertWithinInput, clipItems, utf8Bytes } from '../core/bytes.ts'
import {
  EPOCH_UNITS,
  NORMALIZATION_FORMS,
  convertBase,
  convertTimestamp,
  describeCodePoint,
  inspectCidr,
  inspectJwt,
  normalizeText,
  parseColor,
  type EpochUnit,
  type NormalizationForm,
} from '../core/inspect.ts'
import type { ToolBody } from '../tools.ts'
import { TEXT_INPUT } from './common.ts'

/** Inspection tool bodies. */
export const inspectBodies: ToolBody[] = [
  {
    name: 'unicode_inspect',
    group: 'inspect',
    description:
      'Describe every code point: `U+XXXX`, UTF-8 byte length, general category, script, display width and flags (control, invisible, bidi control, homoglyph risk). Also apply a normalization form and report whether the text changed. Use it when two strings look identical but compare unequal.',
    parameters: {
      text: TEXT_INPUT,
      form: { type: 'string', enum: NORMALIZATION_FORMS, description: 'Normalization form to apply and compare.' },
    },
    result: {
      type: 'object',
      additionalProperties: false,
      properties: {
        code_points: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              index: { type: 'integer', required: true },
              char: { type: 'string', required: true },
              code: { type: 'string', required: true },
              utf8_bytes: { type: 'integer', required: true },
              category: { type: 'string', required: true },
              script: { type: 'string', required: true },
              width: { type: 'integer', required: true },
              flags: { type: 'array', items: { type: 'string' }, required: true },
            },
          },
          required: true,
        },
        counts: {
          type: 'object',
          additionalProperties: false,
          properties: {
            code_points: { type: 'integer', required: true },
            utf16_units: { type: 'integer', required: true },
            utf8_bytes: { type: 'integer', required: true },
            display_width: { type: 'integer', required: true },
            non_ascii: { type: 'integer', required: true },
            flagged: { type: 'integer', required: true },
          },
          required: true,
        },
        scripts: { type: 'json' },
        normalized: { type: 'json' },
      },
    },
    run: (args, limits) => {
      const text = String(args.text)
      const bytesIn = assertWithinInput(text, limits.maxInputBytes)
      const all = [...text].reduce<{ list: ReturnType<typeof describeCodePoint>[]; index: number }>(
        (acc, char) => {
          acc.list.push(describeCodePoint(char, acc.index))
          acc.index += char.length
          return acc
        },
        { list: [], index: 0 },
      )
      const clipped = clipItems(all.list, limits.maxMatches)
      const notes: string[] = []
      if (clipped.truncated) notes.push(`code point list clipped to maxMatches=${limits.maxMatches}`)
      const scripts: Record<string, number> = {}
      let width = 0
      let nonAscii = 0
      let flagged = 0
      for (const info of all.list) {
        scripts[info.script] = (scripts[info.script] ?? 0) + 1
        width += info.width
        if (info.code !== 'U+0000' && info.utf8_bytes > 1) nonAscii += 1
        if (info.flags.length > 0) flagged += 1
      }
      const form = args.form === undefined ? undefined : (String(args.form) as NormalizationForm)
      const normalized = form === undefined ? null : normalizeText(text, form)
      const result = {
        code_points: clipped.items as unknown as never,
        counts: {
          code_points: all.list.length,
          utf16_units: text.length,
          utf8_bytes: utf8Bytes(text),
          display_width: width,
          non_ascii: nonAscii,
          flagged,
        },
        scripts,
        normalized:
          normalized === null
            ? null
            : { form: form as NormalizationForm, changed: normalized.changed, text: normalized.changed ? normalized.text : null, utf8_bytes: utf8Bytes(normalized.text) },
      }
      if (normalized !== null && !normalized.changed) notes.push(`text is already in ${form}`)
      return { result, meta: { bytesIn, bytesOut: utf8Bytes(JSON.stringify(result)), truncated: clipped.truncated, notes } }
    },
  },
  {
    name: 'number_base',
    group: 'inspect',
    description:
      "Convert an integer between bases 2 and 36 using exact big-integer arithmetic. Accepts a leading 0x/0b/0o prefix with from='auto'; digits out of range for the source base are refused rather than truncated.",
    parameters: {
      text: { type: 'string', required: true, description: 'Number digits, optional sign, optional 0x/0b/0o prefix.' },
      from: { type: 'string', description: "Source base 2..36, or 'auto' (default) to read the prefix." },
      to: { type: 'string', description: 'Target base 2..36 (default 10).' },
    },
    result: {
      type: 'object',
      additionalProperties: false,
      properties: {
        value: { type: 'string', required: true },
        from: { type: 'string', required: true },
        to: { type: 'string', required: true },
        negative: { type: 'boolean', required: true },
        decimal: { type: 'string', required: true },
      },
    },
    run: (args) => {
      const text = String(args.text)
      const fromText = args.from === undefined ? 'auto' : String(args.from)
      const to = args.to === undefined ? 10 : Number.parseInt(String(args.to), 10)
      const from = fromText === 'auto' ? 'auto' : Number.parseInt(fromText, 10)
      const converted = convertBase(text, from, to)
      const decimal = convertBase(text, from, 10)
      const result = { value: converted.value, from: fromText, to: String(to), negative: converted.negative, decimal: decimal.value }
      return { result, meta: { bytesIn: utf8Bytes(text), bytesOut: utf8Bytes(JSON.stringify(result)), truncated: false, notes: [] } }
    },
  },
  {
    name: 'color_convert',
    group: 'inspect',
    description:
      'Parse a CSS colour literal (#rgb, #rgba, #rrggbb, #rrggbbaa, rgb(), rgba(), hsl(), hsla()) and return hex, RGB, HSL, HSV, relative luminance and the WCAG contrast ratios against white and black.',
    parameters: { text: { type: 'string', required: true, description: 'Colour literal, e.g. `#0a84ff` or `hsl(211, 100%, 52%)`.' } },
    result: {
      type: 'object',
      additionalProperties: false,
      properties: {
        hex: { type: 'string', required: true },
        hex_with_alpha: { type: 'string', required: true },
        r: { type: 'integer', required: true },
        g: { type: 'integer', required: true },
        b: { type: 'integer', required: true },
        a: { type: 'number', required: true },
        rgb: { type: 'string', required: true },
        hsl: { type: 'string', required: true },
        hsv: { type: 'string', required: true },
        luminance: { type: 'number', required: true },
        contrast_white: { type: 'number', required: true },
        contrast_black: { type: 'number', required: true },
      },
    },
    run: (args) => {
      const text = String(args.text)
      const info = parseColor(text)
      return { result: info as unknown as never, meta: { bytesIn: utf8Bytes(text), bytesOut: utf8Bytes(JSON.stringify(info)), truncated: false, notes: [] } }
    },
  },
  {
    name: 'cidr_inspect',
    group: 'inspect',
    description:
      'Inspect an IPv4 or IPv6 CIDR block: network, netmask, broadcast (IPv4), first/last address, total and usable host counts, whether host bits were already clear, and classification flags (private, loopback, link-local, CGNAT, multicast, ULA).',
    parameters: { text: { type: 'string', required: true, description: 'Block such as `10.0.0.0/8`, `192.168.1.5/24` or `2001:db8::/32`.' } },
    result: {
      type: 'object',
      additionalProperties: false,
      properties: {
        input: { type: 'string', required: true },
        family: { type: 'string', required: true },
        network: { type: 'string', required: true },
        prefix: { type: 'integer', required: true },
        netmask: { type: 'string', required: true },
        broadcast: { oneOf: [{ type: 'string' }, { type: 'null' }] },
        first: { type: 'string', required: true },
        last: { type: 'string', required: true },
        total_addresses: { type: 'string', required: true },
        usable_hosts: { type: 'string', required: true },
        is_network_address: { type: 'boolean', required: true },
        flags: { type: 'array', items: { type: 'string' }, required: true },
      },
    },
    run: (args) => {
      const text = String(args.text)
      const info = inspectCidr(text)
      return { result: info as unknown as never, meta: { bytesIn: utf8Bytes(text), bytesOut: utf8Bytes(JSON.stringify(info)), truncated: false, notes: [] } }
    },
  },
  {
    name: 'jwt_inspect',
    group: 'inspect',
    description:
      'Decode a JWT (compact JWS) header and payload, list alg/typ/kid, signature byte length, exp/iat/nbf as ISO timestamps, and whether it was expired at the evaluation instant. The signature is NOT verified, and that is stated in the result.',
    parameters: {
      token: { type: 'string', required: true, description: 'Compact JWT, three base64url segments.' },
      now: { type: 'string', description: 'ISO 8601 instant used for the expiry decision; defaults to the current time.' },
    },
    result: {
      type: 'object',
      additionalProperties: false,
      properties: {
        segments: { type: 'integer', required: true },
        header: { type: 'json' },
        payload: { type: 'json' },
        alg: { oneOf: [{ type: 'string' }, { type: 'null' }] },
        typ: { oneOf: [{ type: 'string' }, { type: 'null' }] },
        kid: { oneOf: [{ type: 'string' }, { type: 'null' }] },
        signature_bytes: { type: 'integer', required: true },
        expires_at: { oneOf: [{ type: 'string' }, { type: 'null' }] },
        issued_at: { oneOf: [{ type: 'string' }, { type: 'null' }] },
        not_before: { oneOf: [{ type: 'string' }, { type: 'null' }] },
        expired: { oneOf: [{ type: 'boolean' }, { type: 'null' }] },
        evaluated_at: { type: 'string', required: true },
        warnings: { type: 'array', items: { type: 'string' }, required: true },
      },
    },
    run: (args) => {
      const token = String(args.token)
      const info = inspectJwt(token, args.now === undefined ? undefined : String(args.now))
      return { result: info as unknown as never, meta: { bytesIn: utf8Bytes(token), bytesOut: utf8Bytes(JSON.stringify(info)), truncated: false, notes: [] } }
    },
  },
  {
    name: 'timestamp_convert',
    group: 'inspect',
    description:
      'Convert an epoch value (s, ms, µs, ns, or auto-detected by magnitude) or an ISO 8601 string into UTC and offset ISO forms, epoch s/ms, weekday, leap-year flag and a day/hour/minute/second breakdown. Pass the offset explicitly for reproducible output.',
    parameters: {
      value: { type: 'string', required: true, description: 'Epoch digits or an ISO 8601 timestamp.' },
      unit: { type: 'string', enum: EPOCH_UNITS, description: "Epoch unit; 'auto' infers from magnitude (default)." },
      offset_minutes: { type: 'integer', description: 'Offset used for the local rendering, e.g. 480 for UTC+08:00 (default 0).' },
    },
    result: {
      type: 'object',
      additionalProperties: false,
      properties: {
        input: { type: 'string', required: true },
        unit: { type: 'string', required: true },
        iso_utc: { type: 'string', required: true },
        iso_offset: { type: 'string', required: true },
        offset_minutes: { type: 'integer', required: true },
        epoch_seconds: { type: 'number', required: true },
        epoch_millis: { type: 'number', required: true },
        weekday: { type: 'string', required: true },
        leap_year: { type: 'boolean', required: true },
        breakdown: { type: 'json' },
      },
    },
    run: (args) => {
      const value = String(args.value)
      const unit = (args.unit === undefined ? 'auto' : String(args.unit)) as EpochUnit
      const offset = typeof args.offset_minutes === 'number' ? Math.max(-840, Math.min(840, Math.floor(args.offset_minutes))) : 0
      const info = convertTimestamp(value, unit, offset)
      return { result: info as unknown as never, meta: { bytesIn: utf8Bytes(value), bytesOut: utf8Bytes(JSON.stringify(info)), truncated: false, notes: [] } }
    },
  },
]
