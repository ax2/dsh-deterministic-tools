/**
 * Deterministic encoding tools: base64, hex, percent-encoding, and digests.
 * @module dsh-deterministic-tools/core/encoding
 */
import { createHash } from 'node:crypto'
import { UnsupportedOptionError } from './bytes.ts'

/** Digest algorithms this package exposes. */
export const HASH_ALGORITHMS = ['sha256', 'sha512', 'sha1', 'md5'] as const
/** One supported digest algorithm. */
export type HashAlgorithm = (typeof HASH_ALGORITHMS)[number]

/** Why a byte payload could not be read as UTF-8 text. */
export interface DecodedText {
  /** UTF-8 rendering of the bytes. */
  text: string
  /** Byte length of the payload. */
  bytes: number
  /** True when the payload is valid UTF-8; when false, `text` contains U+FFFD. */
  validUtf8: boolean
}

/**
 * Render bytes as UTF-8 text while reporting whether that rendering is lossless.
 * @param buffer - decoded bytes.
 */
export function decodeText(buffer: Buffer): DecodedText {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(buffer)
    return { text, bytes: buffer.length, validUtf8: true }
  } catch {
    return { text: buffer.toString('utf8'), bytes: buffer.length, validUtf8: false }
  }
}

/**
 * Encode text as base64.
 * @param text - source text.
 * @param urlSafe - use the URL-safe alphabet and omit padding.
 */
export function base64Encode(text: string, urlSafe: boolean): string {
  const encoded = Buffer.from(text, 'utf8').toString('base64')
  if (!urlSafe) return encoded
  return encoded.replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')
}

/**
 * Decode base64, validating the alphabet and padding rules first.
 * @param text - candidate base64.
 * @param urlSafe - accept the URL-safe alphabet and missing padding.
 * @returns decoded bytes and the canonical alphabet that matched.
 * @throws when the input is not valid base64.
 */
export function base64Decode(text: string, urlSafe: boolean): { buffer: Buffer; alphabet: 'standard' | 'url_safe' } {
  const compact = text.replace(/\s+/gu, '')
  const standard = /^[A-Za-z0-9+/]*={0,2}$/u.test(compact) && compact.length % 4 === 0
  const safe = /^[A-Za-z0-9_-]*$/u.test(compact) && compact.length % 4 !== 1
  if (standard) return { buffer: Buffer.from(compact, 'base64'), alphabet: 'standard' }
  if (urlSafe && safe) return { buffer: Buffer.from(compact.replaceAll('-', '+').replaceAll('_', '/'), 'base64'), alphabet: 'url_safe' }
  throw new Error('input is not valid base64; expected the standard alphabet with correct padding (set url_safe to accept the URL-safe alphabet)')
}

/**
 * Encode text as hex.
 * @param text - source text.
 * @param upper - uppercase hex digits.
 * @param separator - inserted between bytes.
 */
export function hexEncode(text: string, upper: boolean, separator: string): string {
  const hex = Buffer.from(text, 'utf8').toString('hex')
  const joined = separator.length > 0 ? (hex.match(/../g) ?? []).join(separator) : hex
  return upper ? joined.toUpperCase() : joined
}

/**
 * Decode hex, tolerating whitespace and a separator.
 * @param text - candidate hex.
 * @throws when the input is not valid hex.
 */
export function hexDecode(text: string): Buffer {
  const compact = text.replace(/[\s:,_-]+/gu, '')
  if (!/^[0-9a-fA-F]*$/u.test(compact)) throw new Error('input is not valid hex; expected pairs of hexadecimal digits')
  if (compact.length % 2 !== 0) throw new Error('input has an odd number of hex digits; bytes need pairs')
  return Buffer.from(compact, 'hex')
}

/** Percent-encoding modes. */
export const URL_ENCODE_MODES = ['component', 'form', 'path', 'full'] as const
/** One percent-encoding mode. */
export type UrlEncodeMode = (typeof URL_ENCODE_MODES)[number]

/**
 * Percent-encode text.
 * @param text - source text.
 * @param mode - `component` uses encodeURIComponent, `form` uses `+` for spaces, `path` and `full` keep separators.
 */
export function urlEncode(text: string, mode: UrlEncodeMode): string {
  switch (mode) {
    case 'component':
      return encodeURIComponent(text)
    case 'form':
      return new URLSearchParams({ value: text }).toString().slice('value='.length)
    case 'path':
      return text.split('/').map(encodeURIComponent).join('/')
    case 'full':
      return encodeURI(text)
    default:
      throw new UnsupportedOptionError('mode', mode, URL_ENCODE_MODES)
  }
}

/**
 * Percent-decode text, reporting invalid sequences instead of dropping them.
 * @param text - encoded text.
 * @param plusAsSpace - treat `+` as a space (form encoding).
 */
export function urlDecode(text: string, plusAsSpace: boolean): { text: string; invalidSequences: number } {
  const source = plusAsSpace ? text.replaceAll('+', ' ') : text
  let invalid = 0
  const decoded = source.replace(/%([0-9a-fA-F]{2})|%(?![0-9a-fA-F]{2})/gu, (match, hex: string | undefined) => {
    if (hex === undefined) {
      invalid += 1
      return match
    }
    return String.fromCharCode(Number.parseInt(hex, 16))
  })
  return { text: decodePercentBytes(decoded), invalidSequences: invalid }
}

function decodePercentBytes(text: string): string {
  const bytes: number[] = []
  const out: string[] = []
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0
    if (code <= 0xff) bytes.push(code)
    else {
      if (bytes.length > 0) {
        out.push(Buffer.from(bytes).toString('utf8'))
        bytes.length = 0
      }
      out.push(ch)
    }
  }
  if (bytes.length > 0) out.push(Buffer.from(bytes).toString('utf8'))
  return out.join('')
}

/** One component report for a parsed URL. */
export interface UrlInspection {
  /** Normalized href. */
  href: string
  /** Scheme without the colon. */
  scheme: string
  /** Username, when present. */
  username: string
  /** Whether a password is present (the value itself is never echoed). */
  hasPassword: boolean
  /** Hostname. */
  host: string
  /** Port, or the scheme default when omitted. */
  port: string
  /** Path. */
  path: string
  /** Query string, empty when absent. */
  query: string
  /** Fragment without `#`. */
  hash: string
  /** Decoded query parameters in order. */
  params: { key: string; value: string }[]
  /** Observations worth surfacing, e.g. embedded credentials or a non-ASCII host. */
  warnings: string[]
}

/**
 * Inspect a URL: components plus the parameters a caller usually needs.
 * @param text - candidate URL.
 * @param base - optional base URL for relative references.
 */
export function inspectUrl(text: string, base?: string): UrlInspection {
  const url = base === undefined || base.length === 0 ? new URL(text) : new URL(text, base)
  const params: { key: string; value: string }[] = []
  for (const [key, value] of url.searchParams) params.push({ key, value })
  const warnings: string[] = []
  if (url.username.length > 0 || url.password.length > 0) warnings.push('the URL embeds credentials; do not log or paste it elsewhere')
  if (/[^\u0000-\u007f]/u.test(url.hostname)) warnings.push('the host is an internationalized domain name; the punycode form is used for connections')
  if (url.protocol === 'http:') warnings.push('plain HTTP: the connection is not encrypted')
  return {
    href: url.href,
    scheme: url.protocol.replace(/:$/u, ''),
    username: url.username,
    hasPassword: url.password.length > 0,
    host: url.hostname,
    port: url.port.length > 0 ? url.port : defaultPort(url.protocol),
    path: url.pathname,
    query: url.search.replace(/^\?/u, ''),
    hash: url.hash.replace(/^#/u, ''),
    params,
    warnings,
  }
}

function defaultPort(protocol: string): string {
  switch (protocol) {
    case 'http:':
      return '80'
    case 'https:':
      return '443'
    case 'ftp:':
      return '21'
    case 'ws:':
      return '80'
    case 'wss:':
      return '443'
    default:
      return ''
  }
}

/**
 * Digest text (or base64-decoded bytes) with a named algorithm.
 * @param input - bytes to hash.
 * @param algorithm - digest algorithm.
 * @param encoding - output encoding.
 */
export function hashBytes(input: Buffer, algorithm: HashAlgorithm, encoding: 'hex' | 'base64'): string {
  if (!HASH_ALGORITHMS.includes(algorithm)) throw new UnsupportedOptionError('algorithm', algorithm, HASH_ALGORITHMS)
  return createHash(algorithm).update(input).digest(encoding)
}
