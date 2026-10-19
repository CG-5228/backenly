/**
 * The rules around AI-proposed repairs that hold without a database:
 * what "fixed" requires, that no agent door can approve, and that nothing is
 * promoted to run on its own. tests/integration/ai-fix-proposals.spec.ts runs
 * the whole chain against Postgres.
 */

import fs from 'fs'
import path from 'path'
import { isVerifiedRepair } from '@/lib/core/auto-fix-engine'
import { PROMOTED_AI_REPAIR_CLASSES, isPromoted } from '@/lib/autonomy/ai-promotion'
import { validateAnswer } from '@/lib/autonomy/investigator'

const ROOT = path.resolve(__dirname, '..', '..')
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8')

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = path.join(dir, e.name)
    if (e.isDirectory()) walk(rel, out)
    else if (/\.tsx?$/.test(e.name)) out.push(rel)
  }
  return out
}

describe('what "fixed" requires', () => {
  const all = { postcondition: 'confirmed', recheck: 'resolved', regressionCheck: 'ran', regressions: [] } as const

  it('is all three checks agreeing', () => {
    expect(isVerifiedRepair({ ...all, regressions: [] })).toBe(true)
  })

  it.each([
    { postcondition: 'refuted' as const },
    { postcondition: 'error' as const },
    { recheck: 'unresolved' as const },
    { recheck: 'unknown' as const },
    { recheck: 'error' as const },
    { regressionCheck: 'unavailable' as const },
    { regressions: ['user_data_is_rls_protected'] },
  ])('is never claimed when one disagrees: %o', (over) => {
    expect(isVerifiedRepair({ ...all, regressions: [], ...over })).toBe(false)
  })
})

describe('who can approve', () => {
  it('only the dashboard route, behind a platform session and write access', () => {
    const route = read('app/api/projects/[id]/health/proposals/[proposalId]/approve/route.ts')
    expect(route).toMatch(/withProjectAccess\(/)
    expect(route).toMatch(/canWriteProject\(/)
  })

  it('no agent door can reach an approval', () => {
    const doors = [...walk('app/api/mcp'), ...walk('lib/mcp'), ...walk('lib/ai/brain'), ...walk('app/api/v1')]
    const reaching = doors.filter((f) => /approveProposal|executeApprovedProposal/.test(read(f)))
    expect(reaching).toEqual([])
  })
})

describe('promotion', () => {
  it('ships empty, so no AI-proposed repair runs without a person', () => {
    expect(PROMOTED_AI_REPAIR_CLASSES.size).toBe(0)
    expect(isPromoted('intent_drift:ADD_COLUMN')).toBe(false)
  })
})

describe('the investigator’s answer check', () => {
  const catalog = [{ name: 'orders', columns: ['id'] }]

  it('accepts naming the missing column the finding is about, and nothing else that is missing', () => {
    const answer = { verdict: 'explained' as const, evidenceRefs: ['finding'], namedTables: ['orders'], namedColumns: ['orders.placed_at'] }
    expect(validateAnswer(answer, [], catalog, ['orders.placed_at'])).toEqual({ ok: true, problems: [] })
    expect(validateAnswer(answer, [], catalog, []).problems).toEqual(['names column "orders.placed_at", which does not exist'])
    expect(validateAnswer({ ...answer, namedColumns: ['orders.shipped_at'] }, [], catalog, ['orders.placed_at']).ok).toBe(false)
  })
})
