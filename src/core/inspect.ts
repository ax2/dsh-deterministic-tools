/**
 * Deterministic inspection helpers: Unicode code points, number bases, colours,
 * CIDR ranges, JWT structure, and timestamps. Each function is pure and reports
 * exactly what it could not interpret.
 * @module dsh-deterministic-tools/core/inspect
 */
import { UnsupportedOptionError } from './bytes.ts'
import { base64Decode, decodeText } from './encoding.ts'

/** One inspected code point. */
export interface CodePointInfo {
  /** UTF-16 index of the code point in the input. */
  index: number
  /** Character as written. */
  char: string
  /** `U+XXXX` form. */
  code: string
  /** UTF-8 byte length of this code point. */
  utf8_bytes: number
  /** General category reported by the engine. */
  category: string
  /** Script reported by the engine. */
  script: string
  /** Display width estimate for terminals: 0, 1, or 2. */
  width: number
  /** Flags worth surfacing. */
  flags: string[]
}

const SCRIPT_PATTERNS: ReadonlyArray<readonly [string, RegExp]> = [
  ['Latin', /\p{Script=Latin}/u],
  ['Han', /\p{Script=Han}/u],
  ['Hiragana', /\p{Script=Hiragana}/u],
  ['Katakana', /\p{Script=Katakana}/u],
  ['Hangul', /\p{Script=Hangul}/u],
  ['Cyrillic', /\p{Script=Cyrillic}/u],
  ['Greek', /\p{Script=Greek}/u],
  ['Arabic', /\p{Script=Arabic}/u],
  ['Hebrew', /\p{Script=Hebrew}/u],
  ['Devanagari', /\p{Script=Devanagari}/u],
  ['Thai', /\p{Script=Thai}/u],
  ['Common', /\p{Script=Common}/u],
]

const BIDI_CONTROLS = new Set(['\u200e', '\u200f', '\u202a', '\u202b', '\u202c', '\u202d', '\u202e', '\u2066', '\u2067', '\u2068', '\u2069'])
const INVISIBLE = new Set(['\u200b', '\u200c', '\u200d', '\u2060', '\ufeff', '\u00ad'])
/** Cyrillic/Greek code points that render like Latin letters. */
const CONFUSABLE = /[\u0400-\u04ff\u0370-\u03ff]/

/**
 * Describe one code point.
 * @param char - the code point as a string.
 * @param index - UTF-16 index in the source.
 */
export function describeCodePoint(char: string, index: number): CodePointInfo {
  const cp = char.codePointAt(0) ?? 0
  const script = SCRIPT_PATTERNS.find(([, pattern]) => pattern.test(char))?.[0] ?? 'Unknown'
  const flags: string[] = []
  if (/\p{Cc}/u.test(char)) flags.push('control')
  if (/\p{Cf}/u.test(char)) flags.push('format')
  if (BIDI_CONTROLS.has(char)) flags.push('bidi_control')
  if (INVISIBLE.has(char)) flags.push('invisible')
  if (/\p{White_Space}/u.test(char)) flags.push('whitespace')
  if (CONFUSABLE.test(char)) flags.push('confusable_with_latin')
  const width = /\p{Control}/u.test(char) || INVISIBLE.has(char) || BIDI_CONTROLS.has(char) ? 0 : isWide(cp) ? 2 : 1
  return {
    index,
    char,
    code: `U+${cp.toString(16).toUpperCase().padStart(4, '0')}`,
    utf8_bytes: Buffer.byteLength(char, 'utf8'),
    category: categoryOf(char),
    script,
    width,
    flags,
  }
}

function categoryOf(char: string): string {
  for (const [name, pattern] of CATEGORY_PATTERNS) {
    if (pattern.test(char)) return name
  }
  return 'Unassigned'
}

const CATEGORY_PATTERNS: ReadonlyArray<readonly [string, RegExp]> = [
  ['Cc', /\p{Cc}/u],
  ['Cf', /\p{Cf}/u],
  ['Zs', /\p{Zs}/u],
  ['Lu', /\p{Lu}/u],
  ['Ll', /\p{Ll}/u],
  ['Lt', /\p{Lt}/u],
  ['Lm', /\p{Lm}/u],
  ['Lo', /\p{Lo}/u],
  ['Nd', /\p{Nd}/u],
  ['Nl', /\p{Nl}/u],
  ['No', /\p{No}/u],
  ['Pc', /\p{Pc}/u],
  ['Pd', /\p{Pd}/u],
  ['Ps', /\p{Ps}/u],
  ['Pe', /\p{Pe}/u],
  ['Pi', /\p{Pi}/u],
  ['Pf', /\p{Pf}/u],
  ['Po', /\p{Po}/u],
  ['Sm', /\p{Sm}/u],
  ['Sc', /\p{Sc}/u],
  ['Sk', /\p{Sk}/u],
  ['So', /\p{So}/u],
  ['Mn', /\p{Mn}/u],
  ['Mc', /\p{Mc}/u],
  ['Me', /\p{Me}/u],
]

function isWide(cp: number): boolean {
  return (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe6f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1f64f) ||
    (cp >= 0x1f900 && cp <= 0x1f9ff) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  )
}

/** Unicode normalization forms. */
export const NORMALIZATION_FORMS = ['NFC', 'NFD', 'NFKC', 'NFKD'] as const
/** One normalization form. */
export type NormalizationForm = (typeof NORMALIZATION_FORMS)[number]

/**
 * Normalize text and report how many code points changed.
 * @param text - source text.
 * @param form - normalization form.
 */
export function normalizeText(text: string, form: NormalizationForm): { text: string; changed: boolean } {
  if (!NORMALIZATION_FORMS.includes(form)) throw new UnsupportedOptionError('form', form, NORMALIZATION_FORMS)
  const normalized = text.normalize(form)
  return { text: normalized, changed: normalized !== text }
}

/**
 * Convert an integer between bases 2..36.
 * @param text - source digits, optional `0x`/`0b`/`0o` prefix, optional sign.
 * @param from - source base, or `auto` to read the prefix.
 * @param to - target base.
 */
export function convertBase(text: string, from: number | 'auto', to: number): { value: string; negative: boolean } {
  const trimmed = text.trim()
  if (trimmed.length === 0) throw new Error('number is empty')
  const sign = trimmed.startsWith('-') ? -1 : 1
  const body = trimmed.replace(/^[+-]/u, '')
  let base = from
  let digits = body
  if (base === 'auto') {
    if (/^0[xX]/u.test(body)) {
      base = 16
      digits = body.slice(2)
    } else if (/^0[bB]/u.test(body)) {
      base = 2
      digits = body.slice(2)
    } else if (/^0[oO]/u.test(body)) {
      base = 8
      digits = body.slice(2)
    } else base = 10
  }
  if (typeof base !== 'number' || base < 2 || base > 36) throw new UnsupportedOptionError('from', base, ['auto', '2..36'])
  if (to < 2 || to > 36) throw new UnsupportedOptionError('to', to, ['2..36'])
  const pattern = new RegExp(`^[0-9a-zA-Z]+$`, 'u')
  if (!pattern.test(digits)) throw new Error(`number contains characters that base ${base} cannot represent`)
  let value = 0n
  const big = BigInt(base)
  for (const ch of digits.toLowerCase()) {
    const code = ch.codePointAt(0)!
    const digit = code >= 97 ? code - 87 : code - 48
    if (digit >= base) throw new Error(`digit '${ch}' is out of range for base ${base}`)
    value = value * big + BigInt(digit)
  }
  const magnitude = sign < 0 ? -value : value
  return { value: magnitude.toString(to), negative: sign < 0 }
}

/** Parsed colour. */
export interface ColorInfo {
  /** `#rrggbb`. */
  hex: string
  /** `#rrggbbaa` when alpha is below 1. */
  hex_with_alpha: string
  /** Red channel 0-255. */
  r: number
  /** Green channel 0-255. */
  g: number
  /** Blue channel 0-255. */
  b: number
  /** Alpha 0-1. */
  a: number
  /** `rgb(r, g, b)` or `rgba(...)`. */
  rgb: string
  /** `hsl(h, s%, l%)`. */
  hsl: string
  /** `hsv(h, s%, v%)`. */
  hsv: string
  /** Relative luminance using the WCAG coefficients. */
  luminance: number
  /** Contrast ratio against white and black, rounded to two decimals. */
  contrast_white: number
  /** Contrast ratio against black. */
  contrast_black: number
}

/**
 * Parse `#rgb`/`#rgba`/`#rrggbb`/`#rrggbbaa`, `rgb()`, `rgba()`, `hsl()` or `hsla()`.
 * @param input - colour literal.
 */
export function parseColor(input: string): ColorInfo {
  const text = input.trim().toLowerCase()
  let r: number
  let g: number
  let b: number
  let a = 1
  const hex = /^#([0-9a-f]{3,8})$/u.exec(text)
  if (hex) {
    const digits = hex[1]!
    if (digits.length === 3 || digits.length === 4) {
      r = Number.parseInt(digits[0]! + digits[0]!, 16)
      g = Number.parseInt(digits[1]! + digits[1]!, 16)
      b = Number.parseInt(digits[2]! + digits[2]!, 16)
      if (digits.length === 4) a = Number.parseInt(digits[3]! + digits[3]!, 16) / 255
    } else if (digits.length === 6 || digits.length === 8) {
      r = Number.parseInt(digits.slice(0, 2), 16)
      g = Number.parseInt(digits.slice(2, 4), 16)
      b = Number.parseInt(digits.slice(4, 6), 16)
      if (digits.length === 8) a = Number.parseInt(digits.slice(6, 8), 16) / 255
    } else throw new Error('hex colours need 3, 4, 6 or 8 digits')
  } else {
    const rgb = /^rgba?\(([^)]+)\)$/u.exec(text)
    const hsl = /^hsla?\(([^)]+)\)$/u.exec(text)
    if (rgb) {
      const parts = rgb[1]!.split(/[\s,/]+/u).filter((part) => part.length > 0)
      if (parts.length < 3) throw new Error('rgb() needs three channels')
      r = clampByte(parseChannel(parts[0]!))
      g = clampByte(parseChannel(parts[1]!))
      b = clampByte(parseChannel(parts[2]!))
      if (parts[3] !== undefined) a = clampAlpha(parts[3]!)
    } else if (hsl) {
      const parts = hsl[1]!.split(/[\s,/]+/u).filter((part) => part.length > 0)
      if (parts.length < 3) throw new Error('hsl() needs hue, saturation and lightness')
      const converted = hslToRgb(Number.parseFloat(parts[0]!), Number.parseFloat(parts[1]!) / 100, Number.parseFloat(parts[2]!) / 100)
      r = converted.r
      g = converted.g
      b = converted.b
      if (parts[3] !== undefined) a = clampAlpha(parts[3]!)
    } else {
      throw new Error('unsupported colour literal; use #rgb, #rrggbb, #rrggbbaa, rgb(), rgba(), hsl() or hsla()')
    }
  }
  const { h, s, v } = rgbToHsv(r!, g!, b!)
  return {
    hex: toHex(r!, g!, b!),
    hex_with_alpha: a < 1 ? `${toHex(r!, g!, b!)}${Math.round(a * 255).toString(16).padStart(2, '0')}` : toHex(r!, g!, b!),
    r: r!,
    g: g!,
    b: b!,
    a,
    rgb: a < 1 ? `rgba(${r}, ${g}, ${b}, ${round(a, 3)})` : `rgb(${r}, ${g}, ${b})`,
    hsl: `hsl(${round(h, 1)}, ${round(s * 100, 1)}%, ${round(luminanceToLightness(r!, g!, b!) * 100, 1)}%)`,
    hsv: `hsv(${round(h, 1)}, ${round(s * 100, 1)}%, ${round(v * 100, 1)}%)`,
    luminance: round(relativeLuminance(r!, g!, b!), 4),
    contrast_white: round(contrast(relativeLuminance(r!, g!, b!), 1), 2),
    contrast_black: round(contrast(relativeLuminance(r!, g!, b!), 0), 2),
  }
}

function parseChannel(part: string): number {
  return part.endsWith('%') ? (Number.parseFloat(part) / 100) * 255 : Number.parseFloat(part)
}

function clampByte(value: number): number {
  if (!Number.isFinite(value)) throw new Error('colour channel is not a number')
  return Math.max(0, Math.min(255, Math.round(value)))
}

function clampAlpha(part: string): number {
  const value = part.endsWith('%') ? Number.parseFloat(part) / 100 : Number.parseFloat(part)
  if (!Number.isFinite(value)) throw new Error('alpha is not a number')
  return Math.max(0, Math.min(1, value))
}

function hslToRgb(h: number, s: number, l: number): { r: number; g: number; b: number } {
  const hue = ((h % 360) + 360) % 360 / 360
  if (s === 0) {
    const value = clampByte(l * 255)
    return { r: value, g: value, b: value }
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s
  const p = 2 * l - q
  return {
    r: clampByte(hueToChannel(p, q, hue + 1 / 3) * 255),
    g: clampByte(hueToChannel(p, q, hue) * 255),
    b: clampByte(hueToChannel(p, q, hue - 1 / 3) * 255),
  }
}

function hueToChannel(p: number, q: number, t: number): number {
  let value = t
  if (value < 0) value += 1
  if (value > 1) value -= 1
  if (value < 1 / 6) return p + (q - p) * 6 * value
  if (value < 1 / 2) return q
  if (value < 2 / 3) return p + (q - p) * (2 / 3 - value) * 6
  return p
}

function rgbToHsv(r: number, g: number, b: number): { h: number; s: number; v: number } {
  const max = Math.max(r, g, b) / 255
  const min = Math.min(r, g, b) / 255
  const delta = max - min
  let h = 0
  if (delta !== 0) {
    if (max === r / 255) h = ((g - b) / 255 / delta) % 6
    else if (max === g / 255) h = (b - r) / 255 / delta + 2
    else h = (r - g) / 255 / delta + 4
    h *= 60
    if (h < 0) h += 360
  }
  return { h, s: max === 0 ? 0 : delta / max, v: max }
}

function luminanceToLightness(r: number, g: number, b: number): number {
  return (Math.max(r, g, b) + Math.min(r, g, b)) / 2 / 255
}

function relativeLuminance(r: number, g: number, b: number): number {
  const channel = (value: number): number => {
    const scaled = value / 255
    return scaled <= 0.03928 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
}

function contrast(a: number, b: number): number {
  const light = Math.max(a, b)
  const dark = Math.min(a, b)
  return (light + 0.05) / (dark + 0.05)
}

function toHex(r: number, g: number, b: number): string {
  return `#${[r, g, b].map((value) => value.toString(16).padStart(2, '0')).join('')}`
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

/** CIDR inspection report. */
export interface CidrInfo {
  /** Echo of the input. */
  input: string
  /** `ipv4` or `ipv6`. */
  family: string
  /** Network address. */
  network: string
  /** Prefix length. */
  prefix: number
  /** Netmask in dotted form (IPv4) or prefix form (IPv6). */
  netmask: string
  /** Broadcast address; IPv4 only. */
  broadcast: string | null
  /** First usable address. */
  first: string
  /** Last usable address. */
  last: string
  /** Total addresses in the block, as a decimal string. */
  total_addresses: string
  /** Usable host addresses, as a decimal string. */
  usable_hosts: string
  /** Whether the input host bits were already clear. */
  is_network_address: boolean
  /** Classification flags. */
  flags: string[]
}

/**
 * Inspect an IPv4 or IPv6 CIDR block.
 * @param input - `address/prefix` or a bare address (treated as /32 or /128).
 */
export function inspectCidr(input: string): CidrInfo {
  const [address, prefixText] = input.trim().split('/')
  if (address === undefined || address.length === 0) throw new Error('a CIDR needs an address')
  const family = address.includes(':') ? 6 : 4
  const maxPrefix = family === 4 ? 32 : 128
  const prefix = prefixText === undefined || prefixText === '' ? maxPrefix : Number.parseInt(prefixText, 10)
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > maxPrefix) {
    throw new Error(`prefix must be an integer between 0 and ${maxPrefix}`)
  }
  if (family === 4) {
    const value = parseIpv4(address)
    const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0
    const network = (value & mask) >>> 0
    const broadcast = (network | (~mask >>> 0)) >>> 0
    const total = 2 ** (32 - prefix)
    const usable = prefix >= 31 ? total : Math.max(0, total - 2)
    return {
      input: input.trim(),
      family: 'ipv4',
      network: formatIpv4(network),
      prefix,
      netmask: formatIpv4(mask),
      broadcast: formatIpv4(broadcast),
      first: formatIpv4(prefix >= 31 ? network : network + 1),
      last: formatIpv4(prefix >= 31 ? broadcast : broadcast - 1),
      total_addresses: String(total),
      usable_hosts: String(usable),
      is_network_address: value === network,
      flags: classifyIpv4(network),
    }
  }
  const groups = parseIpv6(address)
  const bits = groups.reduce((acc, group) => (acc << 16n) | group, 0n)
  const shift = BigInt(128 - prefix)
  const network = shift === 0n ? bits : (bits >> shift) << shift
  const total = 2n ** BigInt(128 - prefix)
  const last = network + total - 1n
  return {
    input: input.trim(),
    family: 'ipv6',
    network: formatIpv6(network),
    prefix,
    netmask: `/${prefix}`,
    broadcast: null,
    first: formatIpv6(network),
    last: formatIpv6(last),
    total_addresses: total.toString(),
    usable_hosts: total.toString(),
    is_network_address: bits === network,
    flags: classifyIpv6(network),
  }
}

function parseIpv4(address: string): number {
  const parts = address.split('.')
  if (parts.length !== 4) throw new Error('an IPv4 address needs four octets')
  let value = 0
  for (const part of parts) {
    if (!/^\d{1,3}$/u.test(part)) throw new Error(`'${part}' is not a valid IPv4 octet`)
    const octet = Number.parseInt(part, 10)
    if (octet > 255) throw new Error(`octet ${octet} is above 255`)
    value = (value << 8) | octet
  }
  return value >>> 0
}

function formatIpv4(value: number): string {
  return [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff].join('.')
}

function parseIpv6(address: string): bigint[] {
  const withoutZone = address.split('%')[0]!
  const [head = '', tail = ''] = withoutZone.split('::')
  const headGroups = head.length > 0 ? head.split(':') : []
  const tailGroups = tail.length > 0 ? tail.split(':') : []
  const missing = 8 - headGroups.length - tailGroups.length
  if (!withoutZone.includes('::') && missing !== 0) throw new Error('an IPv6 address needs eight groups')
  if (withoutZone.includes('::') && missing < 0) throw new Error('too many groups for an IPv6 address')
  const groups = [...headGroups, ...Array.from({ length: Math.max(0, missing) }, () => '0'), ...tailGroups]
  return groups.map((group) => {
    if (!/^[0-9a-fA-F]{1,4}$/u.test(group)) throw new Error(`'${group}' is not a valid IPv6 group`)
    return BigInt(Number.parseInt(group, 16))
  })
}

function formatIpv6(value: bigint): string {
  const groups: string[] = []
  for (let shift = 112n; shift >= 0n; shift -= 16n) groups.push(((value >> shift) & 0xffffn).toString(16))
  const compressed = groups.join(':').replace(/\b0(:0)+\b/u, '::')
  return compressed.length < groups.join(':').length ? compressed : groups.join(':')
}

function classifyIpv4(network: number): string[] {
  const flags: string[] = []
  const first = (network >>> 24) & 0xff
  const second = (network >>> 16) & 0xff
  if (first === 10) flags.push('private')
  if (first === 172 && second >= 16 && second <= 31) flags.push('private')
  if (first === 192 && second === 168) flags.push('private')
  if (first === 127) flags.push('loopback')
  if (first === 169 && second === 254) flags.push('link_local')
  if (first >= 224 && first <= 239) flags.push('multicast')
  if (first >= 240) flags.push('reserved')
  if (first === 100 && second >= 64 && second <= 127) flags.push('carrier_grade_nat')
  if (first === 0) flags.push('this_network')
  if (flags.length === 0) flags.push('public')
  return flags
}

function classifyIpv6(network: bigint): string[] {
  const flags: string[] = []
  const top = network >> 112n
  if (network === 0n) flags.push('unspecified')
  else if (network === 1n) flags.push('loopback')
  else if ((network >> 121n) === 0x7en >> 8n || (top & 0xffc0n) === 0xfe80n) flags.push('link_local')
  else if ((top & 0xfe00n) === 0xfc00n) flags.push('unique_local')
  else if ((top & 0xff00n) === 0xff00n) flags.push('multicast')
  else flags.push('global_unicast')
  return flags
}

/** Structural JWT report. The signature is never verified. */
export interface JwtInfo {
  /** Segments found. */
  segments: number
  /** Decoded header, or `null` when it could not be decoded. */
  header: unknown
  /** Decoded payload, or `null` when it could not be decoded. */
  payload: unknown
  /** `alg` claim. */
  alg: string | null
  /** `typ` claim. */
  typ: string | null
  /** `kid` claim. */
  kid: string | null
  /** Signature byte length, base64-url decoded. */
  signature_bytes: number
  /** `exp` as ISO 8601, when present and numeric. */
  expires_at: string | null
  /** `iat` as ISO 8601. */
  issued_at: string | null
  /** `nbf` as ISO 8601. */
  not_before: string | null
  /** Whether the token was expired at the evaluation instant. */
  expired: boolean | null
  /** The instant used for the expiry decision. */
  evaluated_at: string
  /** Observations worth surfacing. */
  warnings: string[]
}

/**
 * Decode a JWT's structure and claims. Never verifies the signature.
 * @param token - compact JWS.
 * @param now - ISO 8601 instant used for expiry; defaults to the current time.
 */
export function inspectJwt(token: string, now?: string): JwtInfo {
  const parts = token.trim().split('.')
  const warnings: string[] = ['the signature is NOT verified; this reports structure and claims only']
  if (parts.length !== 3) warnings.push(`expected three dot-separated segments but found ${parts.length}`)
  const decodeSegment = (segment: string | undefined): unknown => {
    if (segment === undefined || segment.length === 0) return null
    try {
      const { buffer } = base64Decode(segment, true)
      const decoded = JSON.parse(decodeText(buffer).text) as unknown
      return decoded
    } catch {
      return null
    }
  }
  const header = decodeSegment(parts[0])
  const payload = decodeSegment(parts[1])
  let signatureBytes = 0
  if (parts[2] !== undefined && parts[2].length > 0) {
    try {
      signatureBytes = base64Decode(parts[2], true).buffer.length
    } catch {
      warnings.push('the signature segment is not valid base64url')
    }
  } else if (parts.length === 3) {
    warnings.push('the token has an empty signature (alg=none style)')
  }
  const claims = (payload ?? {}) as Record<string, unknown>
  const headerClaims = (header ?? {}) as Record<string, unknown>
  const instant = now === undefined ? new Date() : new Date(now)
  if (Number.isNaN(instant.getTime())) throw new Error('now must be an ISO 8601 timestamp')
  const exp = typeof claims.exp === 'number' ? claims.exp : null
  const nbf = typeof claims.nbf === 'number' ? claims.nbf : null
  const iat = typeof claims.iat === 'number' ? claims.iat : null
  if (headerClaims.alg === 'none') warnings.push('alg is "none": the token carries no signature and must not be trusted')
  if (exp === null) warnings.push('no exp claim: the token does not expire on its own')
  if (payload === null) warnings.push('the payload segment could not be decoded as JSON')
  return {
    segments: parts.length,
    header,
    payload,
    alg: typeof headerClaims.alg === 'string' ? headerClaims.alg : null,
    typ: typeof headerClaims.typ === 'string' ? headerClaims.typ : null,
    kid: typeof headerClaims.kid === 'string' ? headerClaims.kid : null,
    signature_bytes: signatureBytes,
    expires_at: exp === null ? null : new Date(exp * 1000).toISOString(),
    issued_at: iat === null ? null : new Date(iat * 1000).toISOString(),
    not_before: nbf === null ? null : new Date(nbf * 1000).toISOString(),
    expired: exp === null ? null : exp * 1000 <= instant.getTime(),
    evaluated_at: instant.toISOString(),
    warnings,
  }
}

/** Epoch units this package understands. */
export const EPOCH_UNITS = ['s', 'ms', 'us', 'ns', 'auto'] as const
/** One epoch unit. */
export type EpochUnit = (typeof EPOCH_UNITS)[number]

/** Timestamp conversion report. */
export interface TimestampInfo {
  /** Input echo. */
  input: string
  /** Detected or declared unit. */
  unit: string
  /** ISO 8601 in UTC. */
  iso_utc: string
  /** ISO 8601 rendered at the requested offset. */
  iso_offset: string
  /** Offset used for `iso_offset`, in minutes. */
  offset_minutes: number
  /** Epoch seconds. */
  epoch_seconds: number
  /** Epoch milliseconds. */
  epoch_millis: number
  /** Weekday name in UTC. */
  weekday: string
  /** Whether the source year was a leap year. */
  leap_year: boolean
  /** Split of the absolute epoch value. */
  breakdown: { days: number; hours: number; minutes: number; seconds: number; milliseconds: number }
}

/**
 * Convert an epoch value or an ISO 8601 string into the full set of forms.
 * @param input - epoch digits or ISO 8601 timestamp.
 * @param unit - declared unit, or `auto` to infer from magnitude.
 * @param offsetMinutes - offset used for the local rendering.
 */
export function convertTimestamp(input: string, unit: EpochUnit, offsetMinutes: number): TimestampInfo {
  const trimmed = input.trim()
  let millis: number
  let resolvedUnit: string
  if (/^[+-]?\d+(\.\d+)?$/u.test(trimmed)) {
    const numeric = Number.parseFloat(trimmed)
    const resolved = unit === 'auto' ? inferUnit(numeric) : unit
    resolvedUnit = resolved
    const factor = { s: 1_000, ms: 1, us: 1e-3, ns: 1e-6 }[resolved as 's' | 'ms' | 'us' | 'ns']
    millis = numeric * factor
  } else {
    resolvedUnit = 'iso8601'
    millis = new Date(trimmed).getTime()
    if (Number.isNaN(millis)) throw new Error('input is neither an epoch value nor a parseable ISO 8601 timestamp')
  }
  if (!Number.isFinite(millis)) throw new Error('timestamp is outside the representable range')
  const date = new Date(millis)
  const shifted = new Date(millis + offsetMinutes * 60_000)
  const absolute = Math.abs(millis)
  return {
    input: trimmed,
    unit: resolvedUnit,
    iso_utc: date.toISOString(),
    iso_offset: `${shifted.toISOString().replace(/Z$/u, '')}${formatOffset(offsetMinutes)}`,
    offset_minutes: offsetMinutes,
    epoch_seconds: Math.floor(millis / 1000),
    epoch_millis: Math.floor(millis),
    weekday: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][date.getUTCDay()]!,
    leap_year: isLeapYear(date.getUTCFullYear()),
    breakdown: {
      days: Math.floor(absolute / 86_400_000),
      hours: Math.floor(absolute / 3_600_000) % 24,
      minutes: Math.floor(absolute / 60_000) % 60,
      seconds: Math.floor(absolute / 1_000) % 60,
      milliseconds: Math.floor(absolute) % 1_000,
    },
  }
}

function inferUnit(value: number): EpochUnit {
  const magnitude = Math.abs(value)
  if (magnitude >= 1e17) return 'ns'
  if (magnitude >= 1e14) return 'us'
  if (magnitude >= 1e11) return 'ms'
  return 's'
}

function formatOffset(minutes: number): string {
  const sign = minutes < 0 ? '-' : '+'
  const absolute = Math.abs(minutes)
  return `${sign}${String(Math.floor(absolute / 60)).padStart(2, '0')}:${String(absolute % 60).padStart(2, '0')}`
}

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0
}
