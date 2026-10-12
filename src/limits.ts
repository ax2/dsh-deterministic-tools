/**
 * Plugin configuration and the per-call budgets derived from it.
 * @module dsh-deterministic-tools/limits
 */
import z from '@deepseek-ai/schemastery'

/** Effective budgets for one plugin instance. */
export interface Limits {
  /** Hard ceiling on a structured input payload, in UTF-8 bytes. */
  maxInputBytes: number
  /** Soft ceiling on a rendered result, in UTF-8 bytes. */
  maxOutputBytes: number
  /** Ceiling on matches returned by a query or regex tool. */
  maxMatches: number
  /** Ceiling on differences reported by a diff tool. */
  maxDiffEntries: number
  /** Ceiling on regular-expression pattern length. */
  maxPatternChars: number
  /** Separate, tighter ceiling for regex haystacks (backtracking is not preemptible). */
  regexInputBytes: number
  /** Ceiling on CSV records parsed or emitted. */
  maxRecords: number
}

/** Default budgets: generous enough for one pasted report, small enough to stay bounded. */
export const DEFAULT_LIMITS: Limits = {
  maxInputBytes: 262_144,
  maxOutputBytes: 262_144,
  maxMatches: 1_000,
  maxDiffEntries: 2_000,
  maxPatternChars: 1_000,
  regexInputBytes: 65_536,
  maxRecords: 20_000,
}

/** User-facing configuration. */
export interface Config {
  /** Hard ceiling on a structured input payload, in UTF-8 bytes. */
  maxInputBytes?: number
  /** Soft ceiling on a rendered result, in UTF-8 bytes. */
  maxOutputBytes?: number
  /** Ceiling on matches returned by a query or regex tool. */
  maxMatches?: number
  /** Ceiling on differences reported by a diff tool. */
  maxDiffEntries?: number
  /** Ceiling on regular-expression pattern length. */
  maxPatternChars?: number
  /** Separate, tighter ceiling for regex haystacks. */
  regexInputBytes?: number
  /** Ceiling on CSV records parsed or emitted. */
  maxRecords?: number
  /** Tool-name prefix, e.g. `zidev` yields `zidev__json_format`. Empty by default. */
  toolPrefix?: string
  /** Register only these tool names (empty or omitted registers every tool). */
  only?: string[]
}

/** Schemastery schema for {@link Config}. */
export const Config: z<Config> = z.object({
  maxInputBytes: z.natural().default(262_144).description('Hard ceiling on structured input, in UTF-8 bytes.'),
  maxOutputBytes: z.natural().default(262_144).description('Soft ceiling on rendered results, in UTF-8 bytes.'),
  maxMatches: z.natural().default(1_000).description('Ceiling on matches returned by query and regex tools.'),
  maxDiffEntries: z.natural().default(2_000).description('Ceiling on differences reported by diff tools.'),
  maxPatternChars: z.natural().default(1_000).description('Ceiling on regular-expression pattern length.'),
  regexInputBytes: z.natural().default(65_536).description('Ceiling on regex haystack size, in UTF-8 bytes.'),
  maxRecords: z.natural().default(20_000).description('Ceiling on CSV records parsed or emitted.'),
  toolPrefix: z.string().default('').description('Optional prefix for registered tool names.'),
  only: z.array(z.string()).default([]).description('Register only these tool names; empty registers every tool.'),
})

/**
 * Merge user configuration over the defaults.
 * @param config - user configuration, possibly empty.
 */
export function resolveLimits(config: Config = {}): Limits {
  const pick = (value: number | undefined, fallback: number): number =>
    typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback
  return {
    maxInputBytes: pick(config.maxInputBytes, DEFAULT_LIMITS.maxInputBytes),
    maxOutputBytes: pick(config.maxOutputBytes, DEFAULT_LIMITS.maxOutputBytes),
    maxMatches: pick(config.maxMatches, DEFAULT_LIMITS.maxMatches),
    maxDiffEntries: pick(config.maxDiffEntries, DEFAULT_LIMITS.maxDiffEntries),
    maxPatternChars: pick(config.maxPatternChars, DEFAULT_LIMITS.maxPatternChars),
    regexInputBytes: pick(config.regexInputBytes, DEFAULT_LIMITS.regexInputBytes),
    maxRecords: pick(config.maxRecords, DEFAULT_LIMITS.maxRecords),
  }
}
