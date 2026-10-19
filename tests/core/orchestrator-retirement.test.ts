/**
 * RETIRING THE AGENT ORCHESTRATOR FROM AUTONOMY
 * =============================================
 *
 * docs/autonomy-orchestrator-parity.md shows the canonical detectors cover every
 * real problem the orchestrator found. This pins what retiring it must and must
 * not do, against a real database:
 *
 *   - nothing schedules or serves it any more;
 *   - what it filed is withdrawn, with the reason recorded, EXCEPT findings
 *     someone already acted on, which stay listed and say where they came from;
 *   - the trust scoreboard counts undone fixes as rollbacks, not deploys people
 *     rolled back, and a fix nothing confirmed never reads as a verified one.
 */

import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { PrismaClient } from '@prisma/client'
import { randomUUID } from 'crypto'
import { retireOrchestratorFindings } from '@/lib/core/finding-reaper'
import { summariseFinding } from '@/lib/core/finding-summaries'
import { buildTrustReport } from '@/lib/autonomy/trust-report'

const prisma = new PrismaClient()
const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8')

let userId: string
let projectId: string

beforeAll(async () => {
  userId = randomUUID()
  projectId = randomUUID()
  await prisma.user.create({
    data: { id: userId, email: `retire+${userId.slice(0, 8)}@backenly.test`, name: 'retire', password: 'not-a-real-hash' },
  })
  await prisma.project.create({ data: { id: projectId, name: 'orchestrator-retirement', userId } as any })
}, 60_000)

afterAll(async () => {
  await prisma.healthFinding.deleteMany({ where: { projectId } }).catch(() => {})
  await prisma.auditLog.deleteMany({ where: { projectId } }).catch(() => {})
  await prisma.project.deleteMany({ where: { id: projectId } }).catch(() => {})
  await prisma.user.deleteMany({ where: { id: userId } }).catch(() => {})
  await prisma.$disconnect()
}, 60_000)

/** A finding as the orchestrator filed them: `${category}_${location}`, agentType set. */
function filed(type: string, status: string, extra: Record<string, unknown> = {}) {
  return prisma.healthFinding.create({
    data: {
      projectId,
      type,
      severity: 'warning',
      status,
      details: { agentType: 'security', title: `Title for ${type}`, location: 'orders', ...extra } as any,
    },
  })
}

describe('nothing runs the orchestrator any more', () => {
  it('the background monitor runs only the canonical loop', () => {
    const src = read('lib/ai/background-monitor.ts')
    // Imports and calls, not prose: the header explains what was retired.
    expect(src).not.toMatch(/from\s+['"][^'"]*(agent-orchestrator|\/agents\/)[^'"]*['"]/)
    expect(src).not.toMatch(/\b(runAllAgents|executeAutoFixes)\s*\(/)
    expect(src).toContain('runReconciler(projectId)')
  })

  it('the on-demand agents route is gone', () => {
    expect(existsSync(join(process.cwd(), 'app/api/projects/[id]/agents/route.ts'))).toBe(false)
  })
})

describe('retireOrchestratorFindings', () => {
  let untouched: string
  let pending: string
  let approved: string
  let applied: string
  let repaired: string
  let canonical: string

  beforeAll(async () => {
    untouched = (await filed('missing_rls_orders', 'open')).id
    pending = (await filed('auth_gap_auth', 'pending_approval')).id
    approved = (await filed('orphaned_fk_orders', 'pending_approval')).id
    applied = (await filed('missing_index_orders', 'pending_approval', { appliedUnverified: { verifierError: 'x' } })).id
    repaired = (await filed('n_plus_one_risk_orders', 'open', { rollbackData: { statements: [] } })).id
    canonical = (await prisma.healthFinding.create({
      data: { projectId, type: 'missing_rls', severity: 'critical', status: 'open', details: { tableName: 'orders' } as any },
    })).id
    await prisma.auditLog.create({
      data: {
        projectId,
        action: 'HEALTH_FIX_APPROVED',
        type: 'health',
        details: JSON.stringify({ findingId: approved, findingType: 'orphaned_fk_orders' }),
        timestamp: new Date(),
      },
    })
  }, 60_000)

  it('withdraws what nobody acted on and keeps what someone did', async () => {
    const result = await retireOrchestratorFindings(projectId)
    expect(result).toEqual({ withdrawn: 2, kept: 3 })

    const byId = new Map(
      (await prisma.healthFinding.findMany({ where: { projectId } })).map((f) => [f.id, f]),
    )
    for (const id of [untouched, pending]) {
      expect(byId.get(id)?.status).toBe('dismissed')
      expect((byId.get(id)?.details as any).withdrawnBy).toBe('detector_retired')
      expect(typeof (byId.get(id)?.details as any).withdrawnAt).toBe('string')
    }
    expect(byId.get(approved)?.status).toBe('pending_approval')
    expect(byId.get(applied)?.status).toBe('pending_approval')
    expect(byId.get(repaired)?.status).toBe('open')
    // A canonical finding is not the orchestrator's to withdraw.
    expect(byId.get(canonical)?.status).toBe('open')
  }, 60_000)

  it('records the withdrawal once, and a second run finds nothing to do', async () => {
    const rows = await prisma.auditLog.findMany({ where: { projectId, action: 'AUTONOMY_DETECTOR_RETIRED' } })
    expect(rows).toHaveLength(1)
    expect(JSON.parse(rows[0].details as string)).toMatchObject({ withdrawn: 2, kept: 3 })

    expect(await retireOrchestratorFindings(projectId)).toEqual({ withdrawn: 0, kept: 3 })
    expect(await prisma.auditLog.count({ where: { projectId, action: 'AUTONOMY_DETECTOR_RETIRED' } })).toBe(1)
  }, 60_000)

  it('labels what stays as coming from a retired check', () => {
    expect(summariseFinding('orphaned_fk_orders', { agentType: 'repair', title: 'Orphaned FK on "orders.user_id"' }))
      .toBe('From a retired check: Orphaned FK on "orders.user_id"')
    expect(summariseFinding('missing_rls', { tableName: 'orders' })).not.toMatch(/retired/)
  })
})

describe('the trust scoreboard', () => {
  beforeAll(async () => {
    const at = new Date()
    const rows: Array<[string, Record<string, unknown>]> = [
      ['ROLLBACK_DEPLOY', { version: 3 }],
      ['ROLLBACK_TO_VERSION', { version: 2 }],
      ['HEALTH_FIX_ROLLED_BACK', { findingType: 'missing_fk_index', tableName: 'orders', columnName: 'user_id' }],
      ['AGENT_AUTO_FIXED', { title: 'Index on posts.author_id', category: 'missing_index', location: 'posts' }],
      ['HEALTH_AUTO_FIXED', { findingType: 'missing_fk_index', tableName: 'items', columnName: 'order_id', verification: 'confirmed' }],
    ]
    for (const [action, details] of rows) {
      await prisma.auditLog.create({
        data: { projectId, action, type: 'autonomy', details: JSON.stringify(details), timestamp: at },
      })
    }
  }, 60_000)

  it('counts an undone fix as a rollback, and a deploy someone rolled back as none', async () => {
    const report = await buildTrustReport(projectId, 30)
    expect(report.scoreboard.rollbacks).toBe(1)
  }, 60_000)

  it('never renders a fix nothing confirmed as a plain fix', async () => {
    const report = await buildTrustReport(projectId, 30)
    const lines = report.recentActivity.map((a) => a.summary)
    const agent = lines.find((s) => s.includes('posts'))
    const kernel = lines.find((s) => s.includes('items'))
    expect(agent).toMatch(/could not be confirmed/)
    expect(kernel).not.toMatch(/could not be confirmed/)
    expect(lines.some((s) => s.startsWith('You undid a fix'))).toBe(true)
    expect(lines.some((s) => /Withdrew 2 findings from a retired check; 3 you had acted on stay listed/.test(s))).toBe(true)
  }, 60_000)
})
