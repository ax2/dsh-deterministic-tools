/**
 * Helpers shared by the tool-body modules.
 * @module dsh-deterministic-tools/bodies/common
 */
import { clipToBytes, utf8Bytes } from '../core/bytes.ts'
import type { Limits } from '../limits.ts'
import type { ToolBody } from '../tools.ts'

/** The conventional primary input parameter. */
export const TEXT_INPUT = {
  type: 'string',
  required: true,
  description: 'Input document, passed inline.',
} as const

/**
 * Clip a rendered text result and record the truncation in the notes.
 * @param text - candidate output.
 * @param limits - effective budgets.
 * @param notes - mutable note list for this call.
 */
export function boundedText(text: string, limits: Limits, notes: string[] = []): { text: string; truncated: boolean } {
  const clipped = clipToBytes(text, limits.maxOutputBytes)
  if (!clipped.truncated) return { text, truncated: false }
  notes.push(`output clipped to ${limits.maxOutputBytes} bytes (of ${utf8Bytes(text)} bytes); raise maxOutputBytes or narrow the request`)
  return { text: clipped.text, truncated: true }
}

/**
 * Clip a JSON payload by serialized size, falling back to a note when even the
 * clipped form cannot be represented.
 * @param value - canonical payload.
 * @param limits - effective budgets.
 * @param notes - mutable note list for this call.
 */
export function boundedJson<T>(value: T, limits: Limits, notes: string[] = []): { value: T; truncated: boolean } {
  const serialized = JSON.stringify(value) ?? ''
  if (utf8Bytes(serialized) <= limits.maxOutputBytes) return { value, truncated: false }
  notes.push(`result exceeds maxOutputBytes=${limits.maxOutputBytes}; narrow the request`)
  return { value, truncated: true }
}

/** Narrow a body helper's return type for readability. */
export type Body = ToolBody
