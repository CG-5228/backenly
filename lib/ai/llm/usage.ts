/**
 * Usage in one shape for every provider, and what it cost.
 */

import type Anthropic from '@anthropic-ai/sdk'
import { calculateCost, effectiveTokens } from '../cost-tracker'
import type { NormalizedUsage } from './types'

export function normalizeUsage(u: Anthropic.Usage | null | undefined): NormalizedUsage {
  const read = u?.cache_read_input_tokens ?? 0
  const write = u?.cache_creation_input_tokens ?? 0
  const write1h = u?.cache_creation?.ephemeral_1h_input_tokens ?? 0
  const write5m = u?.cache_creation ? (u.cache_creation.ephemeral_5m_input_tokens ?? 0) : Math.max(0, write - write1h)
  const input = u?.input_tokens ?? 0
  return {
    promptTokens: input + read + write,
    inputTokens: input,
    cacheReadTokens: read,
    cacheWrite5mTokens: write5m,
    cacheWrite1hTokens: write1h,
    outputTokens: u?.output_tokens ?? 0,
  }
}

export function costOf(model: string, usage: NormalizedUsage): number {
  return calculateCost(model, usage.promptTokens, usage.outputTokens, usage.cacheReadTokens, {
    tokens5m: usage.cacheWrite5mTokens,
    tokens1h: usage.cacheWrite1hTokens,
  })
}

/**
 * Tokens weighted by what they cost at this model's cache prices: the unit AI
 * credits are metered in (lib/ai/cost-tracker.ts effectiveTokens).
 */
export function effectiveTokensOf(model: string, usage: NormalizedUsage): number {
  return effectiveTokens(usage.promptTokens, usage.outputTokens, usage.cacheReadTokens, {
    model,
    cacheWrite: { tokens5m: usage.cacheWrite5mTokens, tokens1h: usage.cacheWrite1hTokens },
  })
}

/**
 * The same worst case as maxCostOf, in effective tokens: the unit AI credits
 * count, and what a customer's credit hold is sized by.
 */
export function maxEffectiveTokensOf(model: string, params: Anthropic.MessageCreateParamsNonStreaming): number {
  const chars = JSON.stringify([params.system ?? '', params.messages, params.tools ?? []]).length
  const promptTokens = Math.ceil(chars / 3)
  return effectiveTokens(promptTokens, params.max_tokens, 0, { model, cacheWrite: { tokens5m: promptTokens } })
}

/**
 * The most a request can cost, for reserving it before it is sent: every prompt
 * token priced as a cache write (the dearest way it can bill here) and the full
 * output ceiling. The prompt is estimated at three characters a token, more
 * tokens than real text produces, so the estimate errs high.
 */
export function maxCostOf(model: string, params: Anthropic.MessageCreateParamsNonStreaming): number {
  const chars = JSON.stringify([params.system ?? '', params.messages, params.tools ?? []]).length
  const promptTokens = Math.ceil(chars / 3)
  return calculateCost(model, promptTokens, params.max_tokens, 0, { tokens5m: promptTokens })
}
