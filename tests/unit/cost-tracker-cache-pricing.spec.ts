/**
 * Cost and metering by each model's own cache prices.
 *
 * OpenAI bills a cache read at a quarter of the input price and nothing extra
 * to write. Claude bills a read at a tenth and a write at 1.25x (5-minute entry)
 * or 2x (1-hour entry). The OpenAI figures are pinned to what this module
 * produced before Claude pricing was added, so adding it changed none of them.
 */

import { calculateCost, effectiveTokens } from '@/lib/ai/cost-tracker'

const M = 1_000_000

describe('OpenAI figures are unchanged', () => {
  it('prices fresh, cached and output tokens as before', () => {
    // 0.5M fresh x $2 + 0.5M cached x $2 x 0.25 + 1M out x $8
    expect(calculateCost('gpt-4.1', M, M, M / 2)).toBe(9.25)
    expect(calculateCost('gpt-4o-mini', M, M)).toBe(0.75)
    // Longest prefix wins, never bare gpt-4.
    expect(calculateCost('gpt-4.1-mini-2025-04-14', M, 0)).toBe(0.4)
  })

  it('meters cached prompt tokens at a quarter without a model, as before', () => {
    expect(effectiveTokens(1000, 100, 800)).toBe(200 + 200 + 100)
  })
})

describe('Claude cache pricing', () => {
  const opus = 'global.anthropic.claude-opus-4-6-v1'

  it('prices reads at a tenth and writes at 1.25x and 2x of $5', () => {
    // 1M fresh -> $5. 1M read -> $0.50. 1M 5m write -> $6.25. 1M 1h write -> $10.
    expect(calculateCost(opus, M, 0)).toBe(5)
    expect(calculateCost(opus, M, 0, M)).toBe(0.5)
    expect(calculateCost(opus, M, 0, 0, { tokens5m: M })).toBe(6.25)
    expect(calculateCost(opus, M, 0, 0, { tokens1h: M })).toBe(10)
    expect(calculateCost(opus, 0, M)).toBe(25)
  })

  it('names the same model whatever id reaches it', () => {
    expect(calculateCost('claude-opus-4-6', M, M)).toBe(calculateCost(opus, M, M))
  })

  it('never under-prices an unlisted Claude model', () => {
    expect(calculateCost('claude-some-future-model', M, M)).toBe(30)
  })

  it('cannot bill more prompt tokens than there were', () => {
    expect(calculateCost(opus, 100, 0, 80, { tokens5m: 80 })).toBe(calculateCost(opus, 100, 0, 80, { tokens5m: 20 }))
  })

  it('meters by the model it is given', () => {
    // 100 fresh + 1000 read x 0.1 + 400 written x 1.25 + 50 out
    expect(effectiveTokens(1500, 50, 1000, { model: opus, cacheWrite: { tokens5m: 400 } })).toBe(100 + 100 + 500 + 50)
  })
})
