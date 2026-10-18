/**
 * A REGIONAL PROJECT'S APPROVAL REQUESTS STAY IN ITS REGION
 * =========================================================
 * A call an agent parks for a human is a platform row in the home region. For
 * a project kept in another region, the agent's request, the call's target and
 * its exact arguments are kept in the region, written before the row, and the
 * row keeps the tool, a message naming it, a keyed stand-in for the target and
 * the arguments' shape (lib/mcp/approval-request-bodies.ts):
 *   - a request the region cannot keep is not created, and the chat door says
 *     the call was not queued, whatever the model's summary says;
 *   - the Review Queue, check_approval and the briefing tools show the request
 *     read back from the region, and the row as stored when it cannot be read;
 *   - approval runs exactly the call read back from the region; when that call
 *     cannot be read it runs nothing, never marks the request approved, and
 *     closes it with a note to ask the agent again;
 *   - the region keeps the request with its other log bodies, for longer than
 *     a request can wait for approval.
 * A home project's requests are unchanged.
 *
 * Database-free: the platform client is a recorder, each project's region is
 * whatever the test says it is, and a region's database is a map.
 */

import '../helpers/next-request-polyfill'

const mockRegions = new Map<string, string | null>()
const mockApprovals = new Map<string, any>()
/** Every status a request was given, in order. */
const mockStatusLog: Array<{ id: string; status: string }> = []
const mockAudits: any[] = []
/** The order a request's record and its row were written in. */
const mockWrites: string[] = []
/** The regional databases' records, by kind and id. */
const mockBodies = new Map<string, { projectId: string; payload: unknown }>()
/** Projects whose region this process cannot reach. */
const mockUnreachable = new Set<string>()
/** Records the region refuses to write: any that contains one of these. */
const mockRefusedWrites = new Set<string>()
/** The values of each statement the region's prune ran. */
const mockPrunes: unknown[][] = []
/** What the stubbed brain answers the chat door with, and whose key asks. */
let mockBrainTurn: any = null
let mockKeyProject = ''

jest.mock('@/lib/db/prisma', () => {
  const matches = (row: any, where: any): boolean =>
    Object.entries(where ?? {}).every(([key, want]: [string, any]) => {
      if (want && typeof want === 'object' && !(want instanceof Date) && 'gt' in want) return row[key] > want.gt
      return row[key] === want
    })
  const pick = (row: any, select: any) =>
    select ? Object.fromEntries(Object.keys(select).filter((key) => select[key]).map((key) => [key, row[key]])) : row
  // Copies, as a database returns them: a caller's object is never the stored row.
  const approvals = () => [...mockApprovals.values()].map((row) => structuredClone(row))
  const write = (row: any, data: any) => {
    Object.assign(row, structuredClone(data))
    if (data.status) mockStatusLog.push({ id: row.id, status: data.status })
  }
  return {
    prisma: {
      project: {
        findUnique: jest.fn(async ({ where }: any) =>
          mockRegions.has(where.id) ? { region: mockRegions.get(where.id), userId: 'u-owner', name: 'Shop' } : null),
      },
      agentApprovalRequest: {
        create: jest.fn(async ({ data }: any) => {
          const row = structuredClone({
            id: data.id ?? `a${mockApprovals.size + 1}`,
            status: 'pending',
            decidedBy: null,
            decidedAt: null,
            executedAt: null,
            resultSummary: null,
            createdAt: new Date(),
            ...data,
          })
          mockWrites.push(`row:${row.id}`)
          mockApprovals.set(row.id, row)
          return structuredClone(row)
        }),
        findFirst: jest.fn(async ({ where }: any) => approvals().find((row) => matches(row, where)) ?? null),
        findUnique: jest.fn(async ({ where }: any) => approvals().find((row) => row.id === where.id) ?? null),
        findMany: jest.fn(async ({ where, select, take }: any) =>
          approvals()
            .filter((row) => matches(row, where))
            .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
            .slice(0, take ?? Infinity)
            .map((row) => pick(row, select))),
        update: jest.fn(async ({ where, data }: any) => {
          const row = mockApprovals.get(where.id)
          if (!row) throw new Error('Record to update not found.')
          write(row, data)
          return structuredClone(row)
        }),
        updateMany: jest.fn(async ({ where, data }: any) => {
          const row = mockApprovals.get(where.id)
          if (!row || !matches(row, where)) return { count: 0 }
          write(row, data)
          return { count: 1 }
        }),
      },
      auditLog: { create: jest.fn(async ({ data }: any) => { mockAudits.push(data); return data }) },
      platformNotification: { findFirst: jest.fn(async () => null) },
    },
  }
})
jest.mock('@/lib/db', () => jest.requireMock('@/lib/db/prisma'))

// A region's database: records in a map, refused for a project whose region
// this process cannot reach, as the real regional client refuses it.
jest.mock('@/lib/data-plane/regional-bodies', () => {
  const actual = jest.requireActual('@/lib/data-plane/regional-bodies')
  const { projectRegion, RegionNotConfiguredError } = jest.requireActual('@/lib/data-plane/regional')
  return {
    ...actual,
    regionalBodiesFor: jest.fn(async (projectId: string) => {
      const region = await projectRegion(projectId)
      if (region === 'ap-south-1') return actual.BODIES_ON_THE_ROW
      const reach = () => {
        if (mockUnreachable.has(projectId)) throw new RegionNotConfiguredError(region, 'DATABASE_URL_US_EAST_1', projectId)
      }
      const read = (kind: string, id: string) => {
        const body = mockBodies.get(`${kind}:${id}`)
        return body && body.projectId === projectId ? { payload: structuredClone(body.payload), responseBody: null, error: null } : null
      }
      return {
        region,
        set: async (kind: string, id: string, fields: any) => {
          reach()
          const text = JSON.stringify(fields.payload)
          if ([...mockRefusedWrites].some((term) => text.includes(term))) throw new Error('Connection terminated unexpectedly')
          mockWrites.push(`body:${id}`)
          mockBodies.set(`${kind}:${id}`, { projectId, payload: structuredClone(fields.payload) })
        },
        get: async (kind: string, id: string) => { reach(); return read(kind, id) },
        getMany: async (kind: string, ids: string[]) => {
          reach()
          return new Map(ids.flatMap((id) => { const body = read(kind, id); return body ? [[id, body]] : [] }) as any)
        },
        remove: async () => {},
        idsMatching: async () => [],
      }
    }),
  }
})
// The region's own database, for its prune: the statement's values recorded.
jest.mock('@/lib/data-plane/regional', () => ({
  ...jest.requireActual('@/lib/data-plane/regional'),
  regionRawClient: jest.fn(() => ({
    $executeRaw: jest.fn(async (_sql: TemplateStringsArray, ...values: unknown[]) => { mockPrunes.push(values); return 0 }),
  })),
}))

// The approval module's dispatcher and the owner's notice.
jest.mock('@/lib/ai/brain/tools', () => ({ dispatchTool: jest.fn() }))
jest.mock('@/lib/notifications/platform', () => ({ notifyApprovalRequested: jest.fn(async () => {}) }))

// The chat door's key, gates, credits and brain, which this suite stubs rather than runs.
jest.mock('@/lib/mcp/guard', () => ({
  mcpGuard: jest.fn(async () => ({
    auth: { keyId: 'k1', projectId: mockKeyProject, userId: 'u-agent', scope: 'mcp', readOnly: false },
  })),
  recordMcpCall: jest.fn(),
  refuseIfReadOnly: jest.fn(() => null),
}))
jest.mock('@/lib/ai/brain/agent', () => ({ runBrain: jest.fn(async () => mockBrainTurn) }))
jest.mock('@/lib/platform-controls', () => ({ assertAiAllowed: jest.fn(async () => ({ ok: true })) }))
jest.mock('@/lib/entitlements/policy', () => ({ enforceAiCredits: jest.fn(async () => true) }))
jest.mock('@/lib/entitlements/credit-holds', () => ({ closeCreditTurn: jest.fn(async () => {}) }))
jest.mock('@/lib/usage/account', () => ({ creditAccountOf: jest.fn(async () => 'account-1') }))

import { randomBytes } from 'crypto'
import { NextRequest } from 'next/server'
import { NOT_QUOTED } from '@/lib/data-plane/residency'
import { REGIONAL_BODY_RETENTION_DAYS, pruneRegionalBodies } from '@/lib/data-plane/regional-bodies'
import { ApprovalRequestNotKept, approvalTargetStandIn } from '@/lib/mcp/approval-request-bodies'
import { APPROVAL_TTL_MS, createApprovalRequest, decideApproval, getApprovalForProject, listApprovals } from '@/lib/mcp/approvals'
import { listPendingAgentApprovals } from '@/lib/mcp/pending-approvals'
import { dispatchTool } from '@/lib/ai/brain/tools'
import { notifyApprovalRequested } from '@/lib/notifications/platform'
import { POST as chat } from '@/app/api/mcp/chat/route'

const EMAIL = 'alice@example.com'
const MESSAGE = `Block ${EMAIL}, she keeps posting spam`
const TARGET = `the end-user ${EMAIL} (they lose access immediately)`
const CALL = { email: EMAIL, reason: 'spam' }

// A random signing secret for this file only, never a literal.
const savedSecret = process.env.JWT_SECRET
beforeAll(() => { process.env.JWT_SECRET = randomBytes(48).toString('base64') })
afterAll(() => { process.env.JWT_SECRET = savedSecret })

const dispatched = dispatchTool as jest.Mock
const notified = notifyApprovalRequested as jest.Mock
beforeEach(() => dispatched.mockReset())

const blockAlice = (projectId: string) => ({
  projectId,
  userId: 'u-agent',
  apiKeyId: 'k1',
  message: MESSAGE,
  danger: { tool: 'block_end_user', target: TARGET, rowCount: null, reversible: true },
  toolArgs: CALL,
})

const forProject = (rows: any[], projectId: string) => rows.filter((row) => row.projectId === projectId)
const rowsOf = (projectId: string) => forProject([...mockApprovals.values()], projectId)
const statusesOf = (id: string) => mockStatusLog.filter((s) => s.id === id).map((s) => s.status)
const auditOf = (projectId: string, action: string) => {
  const row = mockAudits.find((a) => a.projectId === projectId && a.action === action)
  return row ? JSON.parse(row.details) : undefined
}
const noticesOf = (projectId: string) => notified.mock.calls.filter(([, request]) => request.projectId === projectId)
const flush = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r)) }
const approve = (projectId: string, approvalId: string) =>
  decideApproval({ projectId, approvalId, approverUserId: 'u-owner', decision: 'approve' })

/** Run `fn` with the region's and the door's own complaints kept out of the test output. */
async function quietly<T>(fn: () => Promise<T>): Promise<T> {
  const warn = jest.spyOn(console, 'warn').mockImplementation(() => {})
  const error = jest.spyOn(console, 'error').mockImplementation(() => {})
  try {
    return await fn()
  } finally {
    warn.mockRestore()
    error.mockRestore()
  }
}

describe('creating a request', () => {
  it('keeps a regional project\'s words, target and call in its region, written before the row, which keeps none of them', async () => {
    mockRegions.set('p-use1-create', 'us-east-1')
    const row = await createApprovalRequest(blockAlice('p-use1-create'))
    const stored = mockApprovals.get(row.id)

    // The platform row: the tool, a message naming it, the target's stand-in and the call's shape.
    expect(stored).toMatchObject({
      projectId: 'p-use1-create',
      tool: 'block_end_user',
      message: 'An agent asked to run block_end_user. Its request and exact call are kept in the project’s region.',
      target: `block_end_user target ${approvalTargetStandIn('p-use1-create', TARGET)}`,
      toolArgs: { keptInRegion: true, shape: { email: '[string]', reason: '[string]' } },
      rowCount: null,
      reversible: true,
      status: 'pending',
    })
    expect(JSON.stringify(stored)).not.toContain(EMAIL)
    expect(JSON.stringify(stored)).not.toContain('spam')

    // The region: what a home project's row keeps, under the row's id, written first.
    expect(mockBodies.get(`approval_request:${row.id}`)).toEqual({
      projectId: 'p-use1-create',
      payload: { message: MESSAGE, target: TARGET, toolArgs: CALL },
    })
    expect(mockWrites.filter((w) => w.endsWith(row.id))).toEqual([`body:${row.id}`, `row:${row.id}`])

    // Neither the audit copy nor the owner's notice names the target.
    await flush()
    expect(auditOf('p-use1-create', 'AGENT_APPROVAL_REQUESTED')).toMatchObject({ approvalId: row.id, tool: 'block_end_user' })
    expect(JSON.stringify(forProject(mockAudits, 'p-use1-create'))).not.toContain(EMAIL)
    expect(noticesOf('p-use1-create').map(([, request]) => request)).toEqual([
      expect.objectContaining({ approvalId: row.id, tool: 'block_end_user', target: null }),
    ])
  })

  it('writes no row, and says nothing was queued, when the region cannot keep the request', async () => {
    mockRegions.set('p-use1-nowrite', 'us-east-1')
    mockUnreachable.add('p-use1-nowrite')
    let thrown: unknown
    try {
      await quietly(() => createApprovalRequest(blockAlice('p-use1-nowrite')))
    } catch (err) {
      thrown = err
    } finally {
      mockUnreachable.delete('p-use1-nowrite')
    }
    expect(thrown).toBeInstanceOf(ApprovalRequestNotKept)
    expect((thrown as Error).message).toMatch(/not queued for approval and nothing was run/)
    expect((thrown as Error).message).not.toContain(EMAIL)

    await flush()
    expect(rowsOf('p-use1-nowrite')).toEqual([])
    expect(forProject(mockAudits, 'p-use1-nowrite')).toEqual([])
    expect(noticesOf('p-use1-nowrite')).toEqual([])
  })

  it('writes no row when the region refuses the record itself', async () => {
    mockRegions.set('p-use1-refused', 'us-east-1')
    mockRefusedWrites.add(EMAIL)
    try {
      await expect(quietly(() => createApprovalRequest(blockAlice('p-use1-refused')))).rejects.toBeInstanceOf(ApprovalRequestNotKept)
    } finally {
      mockRefusedWrites.delete(EMAIL)
    }
    expect(rowsOf('p-use1-refused')).toEqual([])
    expect([...mockBodies.values()].filter((b) => b.projectId === 'p-use1-refused')).toEqual([])
  })
})

describe('showing a request', () => {
  it('reads a regional project\'s words and target back from its region for every surface', async () => {
    mockRegions.set('p-use1-show', 'us-east-1')
    const row = await createApprovalRequest(blockAlice('p-use1-show'))

    const [listed] = await listApprovals('p-use1-show')
    expect(listed).toMatchObject({ id: row.id, tool: 'block_end_user', message: MESSAGE, target: TARGET, status: 'pending' })
    expect(await getApprovalForProject('p-use1-show', row.id)).toMatchObject({ id: row.id, status: 'pending', target: TARGET })

    // The briefing tools' list: the target, and never the call.
    const { createdAt, expiresAt } = mockApprovals.get(row.id)
    expect(await listPendingAgentApprovals('p-use1-show')).toEqual([
      { id: row.id, tool: 'block_end_user', target: TARGET, createdAt, expiresAt },
    ])
  })

  it('shows the row as stored, and never fails, when the region cannot be read or no longer has the request', async () => {
    mockRegions.set('p-use1-unread', 'us-east-1')
    const row = await createApprovalRequest(blockAlice('p-use1-unread'))
    const stored = mockApprovals.get(row.id)

    mockUnreachable.add('p-use1-unread')
    try {
      const [listed] = await quietly(() => listApprovals('p-use1-unread'))
      expect(listed).toMatchObject({ id: row.id, message: stored.message, target: stored.target })
      expect((await quietly(() => getApprovalForProject('p-use1-unread', row.id)))?.target).toBe(stored.target)
      expect((await quietly(() => listPendingAgentApprovals('p-use1-unread')))[0]).toMatchObject({ id: row.id, target: stored.target })
    } finally {
      mockUnreachable.delete('p-use1-unread')
    }

    // A request older than the region keeps its record shows its stand-ins too.
    mockBodies.delete(`approval_request:${row.id}`)
    const [pruned] = await listApprovals('p-use1-unread')
    expect(pruned).toMatchObject({ message: stored.message, target: stored.target })
    expect(JSON.stringify(pruned)).not.toContain(EMAIL)
  })
})

describe('approving a regional request', () => {
  it('runs exactly the call kept in the region, and stores only the outcome\'s status', async () => {
    mockRegions.set('p-use1-run', 'us-east-1')
    const row = await createApprovalRequest(blockAlice('p-use1-run'))
    dispatched.mockImplementation(async () => ({ ok: true, summary: `Blocked ${EMAIL}` }))

    // The approver reads the outcome in full.
    expect(await approve('p-use1-run', row.id)).toEqual({ ok: true, status: 'executed', resultSummary: `Blocked ${EMAIL}` })
    expect(dispatched.mock.calls).toEqual([
      ['block_end_user', CALL, expect.objectContaining({ projectId: 'p-use1-run', userId: 'u-owner', destructiveConfirmed: true })],
    ])
    expect(statusesOf(row.id)).toEqual(['approved', 'executed'])

    const stored = mockApprovals.get(row.id)
    expect(stored).toMatchObject({ status: 'executed', resultSummary: NOT_QUOTED, decidedBy: 'u-owner' })
    expect(JSON.stringify(stored)).not.toContain(EMAIL)
    expect(auditOf('p-use1-run', 'AGENT_APPROVAL_GRANTED')).toMatchObject({ approvalId: row.id, tool: 'block_end_user' })
    expect(JSON.stringify(forProject(mockAudits, 'p-use1-run'))).not.toContain(EMAIL)
  })

  it.each([
    ['cannot be reached', 'p-use1-down', /exact call is kept in the project’s region, which could not be reached, so nothing was changed\./],
    ['no longer has it', 'p-use1-gone', /exact call was not found in the project’s region, so nothing was changed\./],
    ['has no call in it', 'p-use1-bad', /exact call was not found in the project’s region, so nothing was changed\./],
  ])('runs nothing when the region %s, and closes the request asking for a new one', async (_how, projectId, why) => {
    mockRegions.set(projectId, 'us-east-1')
    const row = await createApprovalRequest(blockAlice(projectId))
    if (projectId === 'p-use1-gone') mockBodies.delete(`approval_request:${row.id}`)
    if (projectId === 'p-use1-bad') {
      mockBodies.set(`approval_request:${row.id}`, { projectId, payload: { message: MESSAGE, target: TARGET, toolArgs: ['not', 'a', 'call'] } })
    }
    if (projectId === 'p-use1-down') mockUnreachable.add(projectId)

    let decided: Awaited<ReturnType<typeof approve>>
    try {
      decided = await quietly(() => approve(projectId, row.id))
    } finally {
      mockUnreachable.delete(projectId)
    }

    expect(decided).toEqual({ ok: false, status: 'failed', resultSummary: expect.stringMatching(why) })
    expect(decided.resultSummary).toMatch(/Ask your agent to make the change again: it will be held again, as a new request, for your approval\.$/)
    // Nothing ran, and the shape on the row was never offered in the call's place.
    expect(dispatched).not.toHaveBeenCalled()
    // Never claimed: pending to failed, never approved or executed.
    expect(statusesOf(row.id)).toEqual(['failed'])
    expect(mockApprovals.get(row.id)).toMatchObject({ status: 'failed', executedAt: null, decidedBy: 'u-owner', resultSummary: decided.resultSummary })
    expect(auditOf(projectId, 'AGENT_APPROVAL_UNREADABLE_REFUSED')).toMatchObject({ approvalId: row.id, tool: 'block_end_user' })
    expect(auditOf(projectId, 'AGENT_APPROVAL_GRANTED')).toBeUndefined()

    // The agent polling it is told the same, and a second approval runs nothing either.
    expect(await getApprovalForProject(projectId, row.id)).toMatchObject({ status: 'failed', resultSummary: decided.resultSummary })
    expect(await approve(projectId, row.id)).toMatchObject({ ok: false, status: 'failed' })
    expect(dispatched).not.toHaveBeenCalled()
  })

  it('never runs a row that carries the mark from the row itself, wherever its project is', async () => {
    mockRegions.set('p-home-marked', null)
    mockApprovals.set('marked', {
      id: 'marked', projectId: 'p-home-marked', userId: 'u-agent', apiKeyId: 'k1', tool: 'block_end_user',
      message: 'An agent asked to run block_end_user.', target: 'block_end_user target t_x', rowCount: null, reversible: true,
      toolArgs: { keptInRegion: true, shape: { email: '[string]' } },
      status: 'pending', decidedBy: null, decidedAt: null, executedAt: null, resultSummary: null,
      createdAt: new Date(), expiresAt: new Date(Date.now() + APPROVAL_TTL_MS),
    })
    expect(await approve('p-home-marked', 'marked')).toMatchObject({ ok: false, status: 'failed' })
    expect(dispatched).not.toHaveBeenCalled()
    expect(statusesOf('marked')).toEqual(['failed'])
  })

  it('is rejected without its region', async () => {
    mockRegions.set('p-use1-reject', 'us-east-1')
    const row = await createApprovalRequest(blockAlice('p-use1-reject'))
    mockUnreachable.add('p-use1-reject')
    try {
      expect(await decideApproval({ projectId: 'p-use1-reject', approvalId: row.id, approverUserId: 'u-owner', decision: 'reject' }))
        .toEqual({ ok: true, status: 'rejected' })
    } finally {
      mockUnreachable.delete('p-use1-reject')
    }
    expect(dispatched).not.toHaveBeenCalled()
  })
})

describe('a home project\'s request', () => {
  it('is kept, shown and run from its row as before, and nothing is kept in a region', async () => {
    mockRegions.set('p-home', null)
    const row = await createApprovalRequest(blockAlice('p-home'))

    expect(mockApprovals.get(row.id)).toMatchObject({ message: MESSAGE, target: TARGET, toolArgs: CALL, tool: 'block_end_user' })
    expect([...mockBodies.values()].filter((b) => b.projectId === 'p-home')).toEqual([])
    expect(auditOf('p-home', 'AGENT_APPROVAL_REQUESTED').target).toBe(TARGET)
    await flush()
    expect(noticesOf('p-home').map(([, request]) => request.target)).toEqual([TARGET])

    expect((await listApprovals('p-home'))[0]).toMatchObject({ message: MESSAGE, target: TARGET })
    expect(await getApprovalForProject('p-home', row.id)).toMatchObject({ target: TARGET })
    const { createdAt, expiresAt } = mockApprovals.get(row.id)
    expect(await listPendingAgentApprovals('p-home')).toEqual([
      { id: row.id, tool: 'block_end_user', target: TARGET, createdAt, expiresAt },
    ])

    dispatched.mockImplementation(async () => ({ ok: true, summary: `Blocked ${EMAIL}` }))
    expect(await approve('p-home', row.id)).toEqual({ ok: true, status: 'executed', resultSummary: `Blocked ${EMAIL}` })
    expect(dispatched.mock.calls.map(([tool, args]) => [tool, args])).toEqual([['block_end_user', CALL]])
    expect(mockApprovals.get(row.id).resultSummary).toBe(`Blocked ${EMAIL}`)
  })
})

describe('the chat door', () => {
  const blocked = (email: string) => ({
    tool: 'block_end_user',
    args: { email },
    target: `the end-user ${email} (they lose access immediately)`,
    rowCount: null,
    reversible: true,
  })
  async function ask(projectId: string, calls: ReturnType<typeof blocked>[]) {
    mockKeyProject = projectId
    // The model wrote its summary after the gate told it the call would be queued.
    mockBrainTurn = {
      success: true,
      summary: 'I queued the block for your approval.',
      needsUser: false,
      iterations: 2,
      toolsRun: ['finish'],
      classification: { intent: 'DESTRUCTIVE', confidence: 0.9 },
      tokensUsed: 10,
      applied: [],
      blockedCalls: calls,
    }
    const res = await chat(
      new NextRequest('https://backenly.test/api/mcp/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': 'mcp_live_test_key' },
        body: JSON.stringify({ message: 'Block the accounts posting spam' }),
      }),
    )
    return { status: res.status, body: await res.json() }
  }

  it('says a stopped call was not queued, and does not report success, when its request could not be created', async () => {
    mockRegions.set('p-use1-chat-down', 'us-east-1')
    mockUnreachable.add('p-use1-chat-down')
    let answer: Awaited<ReturnType<typeof ask>>
    try {
      answer = await quietly(() => ask('p-use1-chat-down', [blocked(EMAIL)]))
    } finally {
      mockUnreachable.delete('p-use1-chat-down')
    }
    const { status, body } = answer
    expect(status).toBe(200)
    expect(body).toMatchObject({
      ok: false,
      code: 'APPROVAL_FAILED',
      retryable: true,
      approval: null,
      notQueued: [{ tool: 'block_end_user', target: blocked(EMAIL).target }],
    })
    expect(body.status).toBeUndefined()
    expect(body.summary).toContain(`Not queued, and not run: block_end_user on ${blocked(EMAIL).target}.`)
    expect(body.summary).toContain('nothing is waiting in the Review Queue')
    expect(body.summary).not.toContain('⏸')
    expect(rowsOf('p-use1-chat-down')).toEqual([])
  })

  it('names the calls that could not be queued beside the one that was', async () => {
    mockRegions.set('p-use1-chat-some', 'us-east-1')
    mockRefusedWrites.add('bob@example.com')
    let answer: Awaited<ReturnType<typeof ask>>
    try {
      answer = await quietly(() => ask('p-use1-chat-some', [blocked('bob@example.com'), blocked(EMAIL)]))
    } finally {
      mockRefusedWrites.delete('bob@example.com')
    }
    const { body } = answer
    expect(body).toMatchObject({
      ok: true,
      status: 'awaiting_approval',
      approval: { status: 'pending' },
      notQueued: [{ tool: 'block_end_user', target: blocked('bob@example.com').target }],
    })
    expect(body.code).toBeUndefined()
    expect(body.summary).toContain('⏸ This operation needs a human')
    expect(body.summary).toContain(`Not queued, and not run: block_end_user on ${blocked('bob@example.com').target}.`)
    expect(rowsOf('p-use1-chat-some').map((row) => row.id)).toEqual([body.approval.id])
  })
})

describe('how long the region keeps a request', () => {
  it('is longer than a request can wait for approval', () => {
    expect(APPROVAL_TTL_MS).toBeLessThan(REGIONAL_BODY_RETENTION_DAYS * 24 * 60 * 60 * 1000)
  })

  it('is the region\'s retention of its log bodies', async () => {
    mockPrunes.length = 0
    await pruneRegionalBodies('us-east-1')
    expect(mockPrunes).toHaveLength(1)
    const [, kinds] = mockPrunes[0]
    expect(kinds).toContain('approval_request')
    expect(kinds).not.toContain('conversation_message')
  })
})
