/**
 * An approval runs the exact call a human read, or nothing at all.
 *
 * Every request carries the exact tool and arguments it will run. A request
 * that does not (one raised before requests carried their call) must be
 * closed unrun when approved, with the reason recorded.
 *
 * Real database: the request rows, the audit log and the workspace table whose
 * survival proves nothing ran.
 */
import crypto from 'crypto'
import { prisma } from '@/lib/db/prisma'
import { createApprovalRequest, decideApproval } from '@/lib/mcp/approvals'
import { resolveFindingFromChat } from '@/lib/core/auto-fix-engine'

let ownerId: string
let projectId: string
let schema: string

async function tableExists(name: string): Promise<boolean> {
  const rows = await prisma.$queryRawUnsafe<Array<{ n: number }>>(
    `SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = $1 AND table_name = $2`,
    schema,
    name,
  )
  return rows[0].n > 0
}

beforeAll(async () => {
  ownerId = (await prisma.user.create({
    data: { email: `approval-${crypto.randomBytes(6).toString('hex')}@example.test`, password: 'not-a-real-hash', name: 'approver' },
  })).id
  projectId = (await prisma.project.create({ data: { name: 'approval-binding', userId: ownerId } })).id
  schema = `workspace_${projectId}`
  await prisma.$executeRawUnsafe(`CREATE SCHEMA IF NOT EXISTS "${schema}"`)
  await prisma.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS "${schema}"."keep_me" (id serial PRIMARY KEY, label text)`)
}, 60_000)

afterAll(async () => {
  await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {})
  await prisma.agentApprovalRequest.deleteMany({ where: { projectId } }).catch(() => {})
  await prisma.auditLog.deleteMany({ where: { projectId } }).catch(() => {})
  await prisma.project.deleteMany({ where: { userId: ownerId } }).catch(() => {})
  await prisma.user.delete({ where: { id: ownerId } }).catch(() => {})
}, 60_000)

describe('approval binding', () => {
  it('closes a request that names no exact call, runs nothing, and says why', async () => {
    // A request row from before requests carried their call: a message and a
    // tool label, but no arguments.
    const legacy = await prisma.agentApprovalRequest.create({
      data: {
        projectId,
        userId: ownerId,
        message: 'drop the keep_me table',
        tool: 'drop_table',
        target: 'the `keep_me` table',
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    })

    const decided = await decideApproval({
      projectId,
      approvalId: legacy.id,
      approverUserId: ownerId,
      decision: 'approve',
    })

    expect(decided).toMatchObject({ ok: false, status: 'failed' })
    expect(decided.resultSummary).toMatch(/Not executed/)
    expect(decided.resultSummary).toMatch(/Nothing was changed/)

    // Nothing ran: the table the message names is still there.
    expect(await tableExists('keep_me')).toBe(true)

    const row = await prisma.agentApprovalRequest.findUnique({ where: { id: legacy.id } })
    expect(row).toMatchObject({ status: 'failed', decidedBy: ownerId })
    expect(row?.executedAt).toBeNull()

    const audit = await prisma.auditLog.findFirst({
      where: { projectId, action: 'AGENT_APPROVAL_UNBOUND_REFUSED' },
    })
    expect(audit).not.toBeNull()
  }, 60_000)

  it('cannot be approved a second time once closed', async () => {
    const legacy = await prisma.agentApprovalRequest.create({
      data: {
        projectId,
        userId: ownerId,
        message: 'drop the keep_me table',
        tool: 'drop_table',
        target: 'the `keep_me` table',
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    })
    await decideApproval({ projectId, approvalId: legacy.id, approverUserId: ownerId, decision: 'approve' })
    const again = await decideApproval({ projectId, approvalId: legacy.id, approverUserId: ownerId, decision: 'approve' })
    expect(again.ok).toBe(false)
    expect(again.status).toBe('failed')
    expect(await tableExists('keep_me')).toBe(true)
  }, 60_000)

  it('records the exact arguments on every new request', async () => {
    const row = await createApprovalRequest({
      projectId,
      userId: ownerId,
      // A message that names a DIFFERENT target than the call: approval must
      // follow the recorded call, so the message is stored only as context.
      message: 'drop the keep_me table',
      danger: { tool: 'drop_table', target: 'the `drop_me` table', rowCount: null, reversible: false },
      toolArgs: { tableName: 'drop_me' },
    })
    const stored = await prisma.agentApprovalRequest.findUnique({ where: { id: row.id } })
    expect(stored).toMatchObject({ tool: 'drop_table', toolArgs: { tableName: 'drop_me' }, status: 'pending' })
  }, 60_000)

  it('puts a chat-requested fix that needs a person in the Review Queue, and runs nothing', async () => {
    // Removing an endpoint may break clients, so this fix always needs a person.
    const finding = await prisma.healthFinding.create({
      data: { projectId, type: 'dead_api_endpoint', severity: 'warning', details: { path: '/api/old' } },
    })

    const res = await resolveFindingFromChat(finding.id, projectId, {})

    expect(res.outcome).toBe('needs_confirmation')
    expect(res.message).toMatch(/waiting in the Review Queue/)
    expect(res.message).not.toMatch(/confirm and I'll apply/i)
    // The queue lists pending_approval findings only; nothing was applied.
    const after = await prisma.healthFinding.findUnique({ where: { id: finding.id } })
    expect(after).toMatchObject({ status: 'pending_approval', autoFixed: false, fixAppliedAt: null })
    const audit = await prisma.auditLog.findFirst({
      where: { projectId, action: 'HEALTH_FIX_AWAITING_APPROVAL' },
    })
    expect(audit).not.toBeNull()

    // Asking again changes nothing and still points to the queue.
    const again = await resolveFindingFromChat(finding.id, projectId, {})
    expect(again.message).toMatch(/waiting in the Review Queue/)
    expect(await prisma.auditLog.count({ where: { projectId, action: 'HEALTH_FIX_AWAITING_APPROVAL' } })).toBe(1)
  }, 60_000)
})
