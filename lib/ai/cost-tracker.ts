/**
 * LLM COST TRACKER (#14)
 * =======================
 * Tracks real token usage and cost for every model call, OpenAI or Claude.
 * Records to the AiUsage model and aggregates per project per month.
 *
 * Pricing (USD per 1M tokens):
 *   gpt-4o            input: $2.50   output: $10.00
 *   gpt-4o-mini       input: $0.15   output: $0.60
 *   gpt-4-turbo       input: $10.00  output: $30.00
 *   gpt-4             input: $30.00  output: $60.00
 *   gpt-3.5-turbo     input: $0.50   output: $1.50
 *   claude-opus-4-6   input: $5.00   output: $25.00 (Anthropic list price)
 *
 * Caching is priced per model family. OpenAI bills a cache read at a quarter of
 * the input price and charges nothing extra to write one. Claude bills a read at
 * a tenth, and a write at 1.25x (5-minute entry) or 2x (1-hour entry).
 *
 * Alerts when a single request is unexpectedly expensive.
 */

import { canonicalModel, isClaudeModel } from './llm/models'

// ─── Model pricing table (USD per 1M tokens) ──────────────────────────────────
interface ModelPricing {
  inputPer1M: number
  outputPer1M: number
  /** A cache read, as a fraction of the input price. */
  cacheReadMult: number
  /** Writing a 5-minute cache entry, as a fraction of the input price. */
  cacheWrite5mMult: number
  /** Writing a 1-hour cache entry, as a fraction of the input price. */
  cacheWrite1hMult: number
}

const OPENAI_CACHE = { cacheReadMult: 0.25, cacheWrite5mMult: 1, cacheWrite1hMult: 1 } as const
const CLAUDE_CACHE = { cacheReadMult: 0.1, cacheWrite5mMult: 1.25, cacheWrite1hMult: 2 } as const

const MODEL_PRICING: Record<string, ModelPricing> = {
  // gpt-4.1 family — the OpenAI provider's default for most purposes (lib/ai/llm/config.ts).
  // Absent from this table until 2026-07-26, which made every brain call fall
  // through the prefix loop below onto legacy 'gpt-4' at $30/$60 and report
  // ~12x the real cost. 326,874 recorded tokens were billed at $9.87 when the
  // true figure was $0.85.
  'gpt-4.1':         { inputPer1M: 2.00,  outputPer1M: 8.00,  ...OPENAI_CACHE },
  'gpt-4.1-mini':    { inputPer1M: 0.40,  outputPer1M: 1.60,  ...OPENAI_CACHE },
  'gpt-4.1-nano':    { inputPer1M: 0.10,  outputPer1M: 0.40,  ...OPENAI_CACHE },
  'gpt-4o':          { inputPer1M: 2.50,  outputPer1M: 10.00, ...OPENAI_CACHE },
  'gpt-4o-mini':     { inputPer1M: 0.15,  outputPer1M: 0.60,  ...OPENAI_CACHE },
  'gpt-4-turbo':     { inputPer1M: 10.00, outputPer1M: 30.00, ...OPENAI_CACHE },
  'gpt-4':           { inputPer1M: 30.00, outputPer1M: 60.00, ...OPENAI_CACHE },
  'gpt-3.5-turbo':   { inputPer1M: 0.50,  outputPer1M: 1.50,  ...OPENAI_CACHE },
  // Bedrock ids (global.anthropic.claude-opus-4-6-v1) resolve here through
  // canonicalModel. Bedrock bills Claude through AWS Marketplace; the
  // invoice, not this table, is the record of what AWS charged.
  'claude-opus-4-6': { inputPer1M: 5.00,  outputPer1M: 25.00, ...CLAUDE_CACHE },
}

const DEFAULT_PRICING: ModelPricing = { inputPer1M: 2.00, outputPer1M: 8.00, ...OPENAI_CACHE }

/**
 * A Claude model missing from the table is priced as Opus 4.6, the most
 * expensive Claude model routed here, so an unknown one is never under-counted.
 */
const CLAUDE_FALLBACK: ModelPricing = MODEL_PRICING['claude-opus-4-6']

/** Prompt tokens written to the cache, by entry lifetime. */
export interface CacheWrite {
  tokens5m?: number
  tokens1h?: number
}

/** Alert if a single request costs more than this (USD) */
const SINGLE_REQUEST_ALERT_THRESHOLD = 0.10

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Prompt tokens split by how they bill. Clamped so no reading can exceed the
 * prompt or produce a negative bill.
 */
function splitPrompt(promptTokens: number, cachedTokens: number, cacheWrite: CacheWrite) {
  const read = Math.max(0, Math.min(cachedTokens, promptTokens))
  const write5m = Math.max(0, Math.min(cacheWrite.tokens5m ?? 0, promptTokens - read))
  const write1h = Math.max(0, Math.min(cacheWrite.tokens1h ?? 0, promptTokens - read - write5m))
  return { read, write5m, write1h, fresh: promptTokens - read - write5m - write1h }
}

/** Prompt tokens in units of a fresh input token, at this model's cache prices. */
function weightedPrompt(pricing: ModelPricing, promptTokens: number, cachedTokens: number, cacheWrite: CacheWrite): number {
  const p = splitPrompt(promptTokens, cachedTokens, cacheWrite)
  return (
    p.fresh +
    p.read * pricing.cacheReadMult +
    p.write5m * pricing.cacheWrite5mMult +
    p.write1h * pricing.cacheWrite1hMult
  )
}

/**
 * Calculate the USD cost for a given model and token counts.
 *
 * `promptTokens` is every prompt token. `cachedTokens` is the subset read from
 * the cache (OpenAI's `prompt_tokens_details.cached_tokens`, Claude's
 * `cache_read_input_tokens`), and `cacheWrite` the subset written to it, which
 * only Claude reports. Omit both and every prompt token bills at full rate.
 *
 * Cache reads matter far more here than they look. The brain sends its tool
 * catalog (~15.7k tokens) plus a fixed system prompt first in every request,
 * byte-identical across turns, projects and users — a textbook cacheable
 * prefix. Pricing those tokens at full rate overstated the cost of the loop's
 * dominant component by 4x on OpenAI, and would by 10x on Claude.
 */
export function calculateCost(
  model: string,
  promptTokens: number,
  completionTokens: number,
  cachedTokens = 0,
  cacheWrite: CacheWrite = {},
): number {
  const pricing = resolvePricing(model)
  const inputCost = (weightedPrompt(pricing, promptTokens, cachedTokens, cacheWrite) / 1_000_000) * pricing.inputPer1M
  const outputCost = (completionTokens / 1_000_000) * pricing.outputPer1M
  return parseFloat((inputCost + outputCost).toFixed(6))
}

/**
 * Tokens weighted by what they actually cost us, for metering against a user's
 * credit balance. A cached prompt token is a fraction of a fresh one (a quarter
 * on OpenAI, a tenth on Claude), so billing it as a whole one charges the user
 * several times over for a catalog they did not ask for and we did not re-pay
 * for. A Claude cache write costs more than a fresh token, and is metered so.
 *
 * Without `model`, OpenAI's cache prices apply, as they always have here.
 *
 * This is what makes a long multi-step build affordable: iteration 1 pays for
 * the tool catalog, iterations 2..N read it from cache, and the credit meter
 * reflects that instead of charging 15.7k tokens per step.
 */
export function effectiveTokens(
  promptTokens: number,
  completionTokens: number,
  cachedTokens = 0,
  opts: { model?: string; cacheWrite?: CacheWrite } = {},
): number {
  const pricing = opts.model ? resolvePricing(opts.model) : DEFAULT_PRICING
  return Math.round(weightedPrompt(pricing, promptTokens, cachedTokens, opts.cacheWrite ?? {}) + completionTokens)
}

/**
 * Estimate cost before making a call (for pre-flight checks).
 * Uses rough token estimate: 1 token ≈ 4 characters.
 */
export function estimateCost(model: string, estimatedInputChars: number, maxOutputTokens: number): number {
  const estimatedInputTokens = Math.ceil(estimatedInputChars / 4)
  return calculateCost(model, estimatedInputTokens, maxOutputTokens)
}

/**
 * Record actual usage after a completed OpenAI call.
 * Non-blocking — use with .catch(() => {}) pattern.
 */
export async function recordAiUsage(
  projectId: string,
  model: string,
  promptTokens: number,
  completionTokens: number,
  endpoint: string,
  cachedTokens = 0,
  cacheWrite: CacheWrite = {},
): Promise<void> {
  try {
    const { prisma } = await import('@/lib/db/prisma')
    const cost = calculateCost(model, promptTokens, completionTokens, cachedTokens, cacheWrite)
    const totalTokens = promptTokens + completionTokens
    const cacheWriteTokens = (cacheWrite.tokens5m ?? 0) + (cacheWrite.tokens1h ?? 0)

    await prisma.aiUsage.create({
      data: {
        projectId,
        model,
        promptTokens,
        completionTokens,
        totalTokens,
        cost,
        endpoint,
        // Cache hit rate is the single most useful number for reasoning about
        // brain cost, and there is no column for it — `metadata` is Json, so
        // record it there rather than migrate. Lets a query answer "what share
        // of our prompt tokens are we actually re-paying for?"
        metadata: {
          cachedTokens,
          cacheReadTokens: cachedTokens,
          cacheWriteTokens,
          cacheHitRate: promptTokens > 0 ? +(cachedTokens / promptTokens).toFixed(3) : 0,
        },
      },
    })

    // Alert on expensive single requests
    if (cost > SINGLE_REQUEST_ALERT_THRESHOLD) {
      console.warn(
        `[CostTracker] High-cost request: project=${projectId} model=${model} ` +
        `tokens=${totalTokens} cost=$${cost.toFixed(4)} endpoint=${endpoint}`
      )
    }
  } catch (err: any) {
    // Non-fatal — cost tracking failure must never break the AI flow
    console.warn('[CostTracker] Failed to record usage:', err?.message)
  }
}

/**
 * Get total cost for a project this month.
 */
export async function getProjectMonthlyCost(projectId: string): Promise<{
  month: string
  totalCost: number
  totalTokens: number
  callCount: number
  breakdown: Array<{ model: string; cost: number; calls: number; tokens: number }>
}> {
  const { prisma } = await import('@/lib/db/prisma')
  const month = new Date().toISOString().slice(0, 7) // YYYY-MM

  const monthStart = new Date(`${month}-01T00:00:00Z`)
  const monthEnd = new Date(monthStart)
  monthEnd.setMonth(monthEnd.getMonth() + 1)

  const rows = await prisma.aiUsage.findMany({
    where: {
      projectId,
      createdAt: { gte: monthStart, lt: monthEnd },
    },
    select: { model: true, promptTokens: true, completionTokens: true, totalTokens: true, cost: true },
  })

  // Aggregate by model
  const byModel = new Map<string, { cost: number; calls: number; tokens: number }>()
  let totalCost = 0
  let totalTokens = 0

  for (const row of rows) {
    const cost = row.cost ?? calculateCost(row.model, row.promptTokens, row.completionTokens)
    const entry = byModel.get(row.model) || { cost: 0, calls: 0, tokens: 0 }
    entry.cost += cost
    entry.calls += 1
    entry.tokens += row.totalTokens
    byModel.set(row.model, entry)
    totalCost += cost
    totalTokens += row.totalTokens
  }

  const breakdown = [...byModel.entries()].map(([model, data]) => ({
    model,
    cost: parseFloat(data.cost.toFixed(6)),
    calls: data.calls,
    tokens: data.tokens,
  }))

  return {
    month,
    totalCost: parseFloat(totalCost.toFixed(6)),
    totalTokens,
    callCount: rows.length,
    breakdown,
  }
}

/**
 * Get recent usage history for a project (last N calls).
 */
export async function getRecentUsage(projectId: string, limit = 20): Promise<Array<{
  model: string
  promptTokens: number
  completionTokens: number
  cost: number
  endpoint: string
  createdAt: Date
}>> {
  const { prisma } = await import('@/lib/db/prisma')
  const rows = await prisma.aiUsage.findMany({
    where: { projectId },
    orderBy: { createdAt: 'desc' },
    take: limit,
    select: { model: true, promptTokens: true, completionTokens: true, cost: true, endpoint: true, createdAt: true },
  })
  return rows.map((r: any) => ({
    ...r,
    cost: r.cost ?? calculateCost(r.model, r.promptTokens, r.completionTokens),
  }))
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

/**
 * Prefix keys, LONGEST FIRST. Object insertion order is not a pricing decision,
 * but the old loop treated it as one: it returned the first key that matched, so
 * 'gpt-4' (a 5-char prefix of nearly every OpenAI model name) shadowed every
 * longer, more specific entry that happened to sit after it. 'gpt-4.1-2025-04-14'
 * resolved to legacy gpt-4 at $30/$60 instead of $2/$8.
 *
 * Sorting by length makes the match specific-before-general regardless of how
 * the table is written, so adding a model can no longer be silently defeated by
 * where it lands in the literal. Computed once at module load.
 */
const PRICING_PREFIXES = Object.entries(MODEL_PRICING).sort(
  ([a], [b]) => b.length - a.length,
)

function resolvePricing(model: string): ModelPricing {
  const name = canonicalModel(model)
  // Exact match
  if (MODEL_PRICING[name]) return MODEL_PRICING[name]

  // Longest-prefix match (e.g. "gpt-4.1-mini-2025-04-14" → "gpt-4.1-mini",
  // never the shorter "gpt-4.1" and never bare "gpt-4").
  for (const [key, pricing] of PRICING_PREFIXES) {
    if (name.startsWith(key)) return pricing
  }

  return isClaudeModel(model) ? CLAUDE_FALLBACK : DEFAULT_PRICING
}
