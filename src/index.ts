/**
 * dsh-deterministic-tools — deterministic, offline, bounded tools for DeepSeek Harness.
 *
 * Registers a family of format, data, text, encoding and inspection tools. Every
 * tool is pure: no network, no filesystem, no clock, no randomness. Every result
 * carries byte accounting and notes, and every budget refusal is explicit.
 * @module dsh-deterministic-tools
 */
import type { Context } from '@deepseek-ai/cordis'
import { Config, resolveLimits } from './limits.ts'
import { createTools } from './tools.ts'

export const name = 'deterministic-tools'

/** Requires the tool registry before `apply` runs. */
export const inject = ['tools']

export { Config }
export type { Config as DeterministicToolsConfig } from './limits.ts'
export { resolveLimits, DEFAULT_LIMITS } from './limits.ts'
export type { Limits } from './limits.ts'
export { createTools } from './tools.ts'

/**
 * Register every enabled tool. Registration is effect-based, so unloading the
 * plugin unregisters the tools.
 * @param ctx - plugin context.
 * @param config - user configuration.
 */
export function apply(ctx: Context, config: Config = {}): void {
  const limits = resolveLimits(config)
  const only = config.only ?? []
  const prefix = config.toolPrefix ?? ''
  for (const definition of createTools({ limits, prefix, only })) {
    ctx.tools.register(definition)
  }
}
