/**
 * The AI spend ledger against a real Postgres (lib/ai/llm/spend.ts).
 *
 * The property that matters is the one an in-memory test cannot show:
 * concurrent reservations from separate connections cannot overshoot a limit,
 * because the check and the increment are one conditional UPDATE and the row
 * lock makes each waiting writer re-check. Each test uses its own month far in
 * the future, so nothing here touches a real month's spend.
 */

import { prisma } from '@/lib/db/prisma'
import { postgresSpendLedger, type SpendScope } from '@/lib/ai/llm/spend'
import { AiError } from '@/lib/ai/llm/errors'

const MONTHS = ['2099-01', '2099-02', '2099-03', '2099-04']
const at = (month: string) => new Date(`${month}-15T00:00:00Z`)
const input = (amountUsd: number, payer: 'customer' | 'platform' = 'customer') => ({
  purpose: 'brain.agent' as const,
  model: 'claude-opus-4-6',
  payer,
  amountUsd,
  expiresInMs: 60_000,
})

async function period(month: string, scope: SpendScope) {
  const row = await prisma.aiSpendPeriod.findUnique({ where: { month_scope: { month, scope } } })
  return row && { reserved: Number(row.reservedUsd), settled: Number(row.settledUsd), unknown: Number(row.unknownUsd) }
}

afterAll(async () => {
  await prisma.aiSpendHold.deleteMany({ where: { month: { in: MONTHS } } }).catch(() => {})
  await prisma.aiSpendPeriod.deleteMany({ where: { month: { in: MONTHS } } }).catch(() => {})
}, 60_000)

describe('reserving against a limit', () => {
  it('lets exactly as many concurrent reservations through as the limit holds', async () => {
    const month = MONTHS[0]
    const limits = { totalUsd: 1, platformUsd: null }
    const results = await Promise.allSettled(
      Array.from({ length: 20 }, () => postgresSpendLedger.reserve(input(0.1), limits, at(month))),
    )
    const granted = results.filter((r) => r.status === 'fulfilled')
    const refused = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[]
    expect(granted).toHaveLength(10)
    for (const r of refused) expect(r.reason).toMatchObject({ kind: 'spend_limit' })
    expect((await period(month, 'total'))!.reserved).toBeCloseTo(1, 6)
    expect(await prisma.aiSpendHold.count({ where: { month } })).toBe(10)
  }, 60_000)

  it('counts settled and unknown spend against the limit, not just open reservations', async () => {
    const month = MONTHS[1]
    const limits = { totalUsd: 1, platformUsd: null }
    const a = await postgresSpendLedger.reserve(input(0.6), limits, at(month))
    await postgresSpendLedger.settle(a, 'settled', 0.5)
    const b = await postgresSpendLedger.reserve(input(0.4), limits, at(month))
    await postgresSpendLedger.settle(b, 'unknown', 0)
    const refused = await postgresSpendLedger.reserve(input(0.2), limits, at(month)).catch((e) => e)
    expect(refused).toBeInstanceOf(AiError)
    expect(refused).toMatchObject({ kind: 'spend_limit' })
    expect(await period(month, 'total')).toEqual({ reserved: 0, settled: 0.5, unknown: 0.4 })
  }, 60_000)

  it('reserves deployment-paid calls against both the total and the platform budget', async () => {
    const month = MONTHS[2]
    const limits = { totalUsd: null, platformUsd: 0.3 }
    const hold = await postgresSpendLedger.reserve(input(0.25, 'platform'), limits, at(month))
    expect(hold.scopes).toEqual(['total', 'platform'])
    const refused = await postgresSpendLedger.reserve(input(0.25, 'platform'), limits, at(month)).catch((e) => e)
    expect(refused).toMatchObject({ kind: 'spend_limit' })
    // A customer call is not held against the platform budget.
    await postgresSpendLedger.reserve(input(0.25), limits, at(month))
    expect((await period(month, 'platform'))!.reserved).toBeCloseTo(0.25, 6)
    expect((await period(month, 'total'))!.reserved).toBeCloseTo(0.5, 6)
  }, 60_000)
})

describe('settling', () => {
  it('settles each reservation once, three ways, and expires the abandoned one', async () => {
    const month = MONTHS[3]
    const limits = { totalUsd: null, platformUsd: null }
    const ran = await postgresSpendLedger.reserve(input(0.3), limits, at(month))
    const refused = await postgresSpendLedger.reserve(input(0.3), limits, at(month))
    const lost = await postgresSpendLedger.reserve(input(0.3), limits, at(month))
    const abandoned = await postgresSpendLedger.reserve({ ...input(0.3), expiresInMs: 1 }, limits, at(month))

    await postgresSpendLedger.settle(ran, 'settled', 0.12)
    await postgresSpendLedger.settle(ran, 'settled', 0.12) // a second settle changes nothing
    await postgresSpendLedger.settle(refused, 'released', 0)
    await postgresSpendLedger.settle(lost, 'unknown', 0)
    expect(await postgresSpendLedger.expire(new Date(at(month).getTime() + 1000))).toBeGreaterThanOrEqual(1)

    expect(await period(month, 'total')).toEqual({ reserved: 0, settled: 0.12, unknown: 0.6 })
    const status = new Map(
      (await prisma.aiSpendHold.findMany({ where: { month }, select: { id: true, status: true } })).map((h) => [h.id, h.status]),
    )
    expect(status.get(ran.id)).toBe('settled')
    expect(status.get(refused.id)).toBe('released')
    expect(status.get(lost.id)).toBe('unknown')
    expect(status.get(abandoned.id)).toBe('unknown')
  }, 60_000)
})
