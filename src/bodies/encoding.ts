/**
 * Tool bodies for the encoding group: base64, hex, percent-encoding, digests.
 * @module dsh-deterministic-tools/bodies/encoding
 */
import { assertWithinInput, utf8Bytes } from '../core/bytes.ts'
import {
  HASH_ALGORITHMS,
  URL_ENCODE_MODES,
  base64Decode,
  base64Encode,
  decodeText,
  hashBytes,
  hexDecode,
  hexEncode,
  inspectUrl,
  urlDecode,
  urlEncode,
  type HashAlgorithm,
  type UrlEncodeMode,
} from '../core/encoding.ts'
import type { ToolBody } from '../tools.ts'
import { TEXT_INPUT } from './common.ts'

const DECODED_RESULT = {
  type: 'object',
  additionalProperties: false,
  properties: {
    text: { type: 'string', required: true, description: 'UTF-8 rendering of the decoded bytes.' },
    bytes: { type: 'integer', required: true },
    valid_utf8: { type: 'boolean', required: true, description: 'False when the bytes are not valid UTF-8; the text then contains U+FFFD.' },
  },
} as const

/** Encoding tool bodies. */
export const encodingBodies: ToolBody[] = [
  {
    name: 'base64_encode',
    group: 'encoding',
    description: 'Encode UTF-8 text as base64, standard or URL-safe (URL-safe drops padding).',
    parameters: {
      text: { type: 'string', required: true, description: 'Text to encode.' },
      url_safe: { type: 'boolean', description: 'Use the URL-safe alphabet and omit padding.' },
    },
    result: {
      type: 'object',
      additionalProperties: false,
      properties: {
        base64: { type: 'string', required: true },
        alphabet: { type: 'string', required: true },
        bytes_in: { type: 'integer', required: true },
      },
    },
    run: (args) => {
      const text = String(args.text)
      const urlSafe = args.url_safe === true
      const base64 = base64Encode(text, urlSafe)
      const result = { base64, alphabet: urlSafe ? 'url_safe' : 'standard', bytes_in: utf8Bytes(text) }
      return { result, meta: { bytesIn: utf8Bytes(text), bytesOut: utf8Bytes(JSON.stringify(result)), truncated: false, notes: [] } }
    },
  },
  {
    name: 'base64_decode',
    group: 'encoding',
    description:
      'Decode base64 to text. The alphabet and padding are validated first, and invalid UTF-8 is reported instead of silently replaced.',
    parameters: {
      text: { type: 'string', required: true, description: 'Base64 text; whitespace is ignored.' },
      url_safe: { type: 'boolean', description: 'Accept the URL-safe alphabet without padding.' },
    },
    result: {
      type: 'object',
      additionalProperties: false,
      properties: {
        ...DECODED_RESULT.properties,
        alphabet: { type: 'string', required: true },
        hex_preview: { type: 'string', required: true, description: 'First 32 bytes as hex.' },
      },
    },
    run: (args) => {
      const text = String(args.text)
      const { buffer, alphabet } = base64Decode(text, args.url_safe === true)
      const decoded = decodeText(buffer)
      const notes: string[] = []
      if (!decoded.validUtf8) notes.push('decoded bytes are not valid UTF-8; `text` is a lossy rendering, use hex_preview for the raw prefix')
      const result = {
        text: decoded.text,
        bytes: decoded.bytes,
        valid_utf8: decoded.validUtf8,
        alphabet,
        hex_preview: buffer.subarray(0, 32).toString('hex'),
      }
      return { result, meta: { bytesIn: utf8Bytes(text), bytesOut: utf8Bytes(JSON.stringify(result)), truncated: false, notes } }
    },
  },
  {
    name: 'hex_encode',
    group: 'encoding',
    description: 'Encode UTF-8 text as hexadecimal, with an optional byte separator.',
    parameters: {
      text: { type: 'string', required: true, description: 'Text to encode.' },
      upper: { type: 'boolean', description: 'Uppercase hex digits (default false).' },
      separator: { type: 'string', description: "Byte separator, e.g. ' ' or ':'; empty by default." },
    },
    result: {
      type: 'object',
      additionalProperties: false,
      properties: { hex: { type: 'string', required: true }, bytes: { type: 'integer', required: true } },
    },
    run: (args) => {
      const text = String(args.text)
      const hex = hexEncode(text, args.upper === true, args.separator === undefined ? '' : String(args.separator))
      const result = { hex, bytes: utf8Bytes(text) }
      return { result, meta: { bytesIn: utf8Bytes(text), bytesOut: utf8Bytes(JSON.stringify(result)), truncated: false, notes: [] } }
    },
  },
  {
    name: 'hex_decode',
    group: 'encoding',
    description: 'Decode hexadecimal to text, tolerating whitespace and `:`/`-`/`,` separators. Invalid UTF-8 is reported, not hidden.',
    parameters: { text: { type: 'string', required: true, description: 'Hexadecimal digits, optionally separated.' } },
    result: DECODED_RESULT,
    run: (args) => {
      const text = String(args.text)
      const buffer = hexDecode(text)
      const decoded = decodeText(buffer)
      const notes: string[] = []
      if (!decoded.validUtf8) notes.push('decoded bytes are not valid UTF-8; `text` is a lossy rendering')
      const result = { text: decoded.text, bytes: decoded.bytes, valid_utf8: decoded.validUtf8 }
      return { result, meta: { bytesIn: utf8Bytes(text), bytesOut: utf8Bytes(JSON.stringify(result)), truncated: false, notes } }
    },
  },
  {
    name: 'url_encode',
    group: 'encoding',
    description:
      "Percent-encode text: 'component' escapes everything reserved (query values, path segments), 'form' uses `+` for spaces, 'path' keeps `/`, 'full' keeps URL structure.",
    parameters: {
      text: { type: 'string', required: true, description: 'Text to encode.' },
      mode: { type: 'string', enum: URL_ENCODE_MODES, description: "Encoding mode (default 'component')." },
    },
    result: {
      type: 'object',
      additionalProperties: false,
      properties: { encoded: { type: 'string', required: true }, mode: { type: 'string', required: true } },
    },
    run: (args) => {
      const text = String(args.text)
      const mode = (args.mode === undefined ? 'component' : String(args.mode)) as UrlEncodeMode
      const encoded = urlEncode(text, mode)
      const result = { encoded, mode }
      return { result, meta: { bytesIn: utf8Bytes(text), bytesOut: utf8Bytes(JSON.stringify(result)), truncated: false, notes: [] } }
    },
  },
  {
    name: 'url_decode',
    group: 'encoding',
    description:
      'Percent-decode text (UTF-8 aware) and count malformed `%` sequences instead of dropping them. Set plus_as_space for form-encoded input.',
    parameters: {
      text: { type: 'string', required: true, description: 'Percent-encoded text.' },
      plus_as_space: { type: 'boolean', description: "Treat '+' as a space (form encoding)." },
    },
    result: {
      type: 'object',
      additionalProperties: false,
      properties: { text: { type: 'string', required: true }, invalid_sequences: { type: 'integer', required: true } },
    },
    run: (args) => {
      const text = String(args.text)
      const decoded = urlDecode(text, args.plus_as_space === true)
      const notes: string[] = []
      if (decoded.invalidSequences > 0) notes.push(`${decoded.invalidSequences} malformed percent sequence(s) were left verbatim`)
      const result = { text: decoded.text, invalid_sequences: decoded.invalidSequences }
      return { result, meta: { bytesIn: utf8Bytes(text), bytesOut: utf8Bytes(JSON.stringify(result)), truncated: false, notes } }
    },
  },
  {
    name: 'url_inspect',
    group: 'encoding',
    description:
      'Split a URL into scheme, host, port, path, query and fragment, decode the query parameters in order, and flag embedded credentials, plain HTTP and non-ASCII hosts. Relative references need a base.',
    parameters: {
      url: { type: 'string', required: true, description: 'Absolute URL, or a relative reference together with base.' },
      base: { type: 'string', description: 'Base URL used to resolve a relative reference.' },
    },
    result: {
      type: 'object',
      additionalProperties: false,
      properties: {
        href: { type: 'string', required: true },
        scheme: { type: 'string', required: true },
        username: { type: 'string', required: true },
        has_password: { type: 'boolean', required: true },
        host: { type: 'string', required: true },
        port: { type: 'string', required: true },
        path: { type: 'string', required: true },
        query: { type: 'string', required: true },
        hash: { type: 'string', required: true },
        params: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: { key: { type: 'string', required: true }, value: { type: 'string', required: true } },
          },
          required: true,
        },
        warnings: { type: 'array', items: { type: 'string' }, required: true },
      },
    },
    run: (args) => {
      const url = String(args.url)
      const base = args.base === undefined ? undefined : String(args.base)
      const info = inspectUrl(url, base)
      const result = {
        href: info.href,
        scheme: info.scheme,
        username: info.username,
        has_password: info.hasPassword,
        host: info.host,
        port: info.port,
        path: info.path,
        query: info.query,
        hash: info.hash,
        params: info.params,
        warnings: info.warnings,
      }
      return {
        result,
        meta: { bytesIn: utf8Bytes(url), bytesOut: utf8Bytes(JSON.stringify(result)), truncated: false, notes: [] },
      }
    },
  },
  {
    name: 'hash_text',
    group: 'encoding',
    description: 'Digest UTF-8 text with sha256 (default), sha512, sha1 or md5, in hex or base64. Input as base64 instead of text when the payload is binary.',
    parameters: {
      text: { type: 'string', description: 'Text to digest.' },
      base64: { type: 'string', description: 'Base64 payload to digest instead of text.' },
      algorithm: { type: 'string', enum: HASH_ALGORITHMS, description: 'Digest algorithm (default sha256).' },
      encoding: { type: 'string', enum: ['hex', 'base64'], description: 'Output encoding (default hex).' },
    },
    result: {
      type: 'object',
      additionalProperties: false,
      properties: {
        digest: { type: 'string', required: true },
        algorithm: { type: 'string', required: true },
        encoding: { type: 'string', required: true },
        bytes: { type: 'integer', required: true },
      },
    },
    run: (args, limits) => {
      const algorithm = (args.algorithm === undefined ? 'sha256' : String(args.algorithm)) as HashAlgorithm
      const encoding = args.encoding === 'base64' ? 'base64' : 'hex'
      let buffer: Buffer
      if (typeof args.base64 === 'string' && args.base64.length > 0) {
        buffer = base64Decode(args.base64, true).buffer
      } else if (typeof args.text === 'string') {
        buffer = Buffer.from(args.text, 'utf8')
      } else {
        throw new Error('provide either text or base64')
      }
      const bytesIn = assertWithinInput(buffer.toString('latin1'), limits.maxInputBytes, 'digest input')
      const digest = hashBytes(buffer, algorithm, encoding)
      const result = { digest, algorithm, encoding, bytes: buffer.length }
      return { result, meta: { bytesIn, bytesOut: utf8Bytes(JSON.stringify(result)), truncated: false, notes: [] } }
    },
  },
]
