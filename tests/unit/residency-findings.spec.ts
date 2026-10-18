/**
 * A REGIONAL PROJECT'S HEALTH FINDINGS AND HELD ACTIONS QUOTE NONE OF ITS DATA
 * ============================================================================
 * Health findings and the timeline are platform rows, in the home region. For
 * a project kept in another region (founders' residency table, 2026-10-16):
 *   - a broken contract probe keeps what failed and how (surface, request,
 *     status, size of the answer), never the answer's body or the handler's
 *     message, which can echo a row;
 *   - a failed repair keeps its message only when it is an error code, and the
 *     full message goes only to the log of a process serving that region;
 *   - an action held for approval keeps its target and arguments on the
 *     finding, which is what the approver reads (as an approval request does),
 *     while its timeline event names the action only.
 * A home project's rows are unchanged, except that no approval records a held
 * action's arguments, in any region: the record keeps their shape, since the
 * arguments can carry a secret.
 *
 * Database-free: the platform clients are recorders, and each project's region
 * is whatever the test says it is.
 */

const mockRegions = new Map<string, string | null>()
const mockEvents: any[] = []
const mockFindings = new Map<string, any>()
const mockAudits: any[] = []
const mockCorrections: any[] = []
const mockExecuted: any[] = []
const mockLoop = {
  executor: (action: any): any => {
    const target = action.params?.email ?? action.params?.key ?? action.params?.tableName
    return { success: true, message: `${action.action} ran on ${target}`, data: { target } }
  },
  baseline: async (): Promise<unknown> => ({}),
  outcome: async (): Promise<unknown> => ({ accepted: true, recheck: 'resolved', regressions: [], regressionCheck: 'ran', reason: '' }),
}

jest.mock('@/lib/db/prisma', () => {
  const matches = (row: any, where: any): boolean =>
    Object.entries(where ?? {}).every(([key, want]: [string, any]) => {
      if (key === 'AND') return want.every((clause: any) => matches(row, clause))
      if (key === 'OR') return want.some((clause: any) => matches(row, clause))
      if (key === 'details') return row.details?.[want.path[0]] === want.equals
      if (want && typeof want === 'object' && Array.isArray(want.in)) return want.in.includes(row[key])
      return row[key] === want
    })
  // Copies, as a database returns them: a caller's object is never the stored row.
  const findings = () => [...mockFindings.values()].map((row) => structuredClone(row))
  return {
    prisma: {
      project: {
        findUnique: jest.fn(async ({ where }: any) =>
          mockRegions.has(where.id) ? { region: mockRegions.get(where.id), userId: 'u-owner', name: 'Shop' } : null),
      },
      backendEvent: {
        create: jest.fn(async ({ data }: any) => { mockEvents.push(data); return { id: `e${mockEvents.length}`, ...data } }),
        update: jest.fn(async ({ data }: any) => data),
        updateMany: jest.fn(async () => ({ count: 0 })),
      },
      healthFinding: {
        findFirst: jest.fn(async ({ where }: any) => findings().find((row) => matches(row, where)) ?? null),
        findUnique: jest.fn(async ({ where }: any) => findings().find((row) => row.id === where.id) ?? null),
        findMany: jest.fn(async ({ where }: any) => findings().filter((row) => matches(row, where))),
        create: jest.fn(async ({ data }: any) => {
          const row = structuredClone({ id: data.id ?? `f${mockFindings.size + 1}`, detectedAt: new Date(), ...data })
          mockFindings.set(row.id, row)
          return structuredClone(row)
        }),
        update: jest.fn(async ({ where, data }: any) => {
          const row = mockFindings.get(where.id)
          if (!row || !matches(row, where)) throw new Error('Record to update not found.')
          return structuredClone(Object.assign(row, structuredClone(data)))
        }),
        updateMany: jest.fn(async () => ({ count: 0 })),
      },
      auditLog: {
        create: jest.fn(async ({ data }: any) => { mockAudits.push(data); return data }),
        findMany: jest.fn(async () => []),
        count: jest.fn(async () => 0),
      },
      correctionEvent: { create: jest.fn(async ({ data }: any) => { mockCorrections.push(data); return data }) },
      backendPattern: { upsert: jest.fn(async () => ({})) },
    },
  }
})
jest.mock('@/lib/db', () => jest.requireMock('@/lib/db/prisma'))

// The executor and the loop's checks, which this suite drives rather than runs.
jest.mock('@/lib/ai/minimal-executor', () => ({
  executeAction: jest.fn(async (action: any) => { mockExecuted.push(action); return mockLoop.executor(action) }),
}))
jest.mock('@/lib/ai/build-runtime/build-lock', () => ({
  withBuildLock: jest.fn(async (_projectId: string, _kind: string, fn: () => Promise<unknown>) => ({ result: await fn() })),
}))
jest.mock('@/lib/execution/sql-recorder', () => ({
  installSqlRecorder: jest.fn(),
  withSqlCapture: jest.fn(async (fn: () => Promise<unknown>) => ({ result: await fn(), statements: [] })),
}))
jest.mock('@/lib/services/workspace-schema-snapshot', () => ({
  captureSchemaSnapshot: jest.fn(async () => null),
  rollbackToSchemaVersion: jest.fn(),
}))
jest.mock('@/lib/autonomy/desired-state', () => ({
  captureCheckBaseline: jest.fn(() => mockLoop.baseline()),
  evaluateFixOutcome: jest.fn(() => mockLoop.outcome()),
  recheckGap: jest.fn(async () => 'unknown'),
}))
jest.mock('@/lib/autonomy/circuit-breaker', () => ({
  checkBreaker: jest.fn(async () => ({ allowed: true })),
  auditBreakerTrip: jest.fn(),
}))
jest.mock('@/lib/autonomy/maintenance/primitives/recovery-restore-policies', () => ({
  capturePolicies: jest.fn(),
  recoveryRestorePolicies: jest.fn(),
  samePolicies: jest.fn(),
}))
jest.mock('@/lib/memory/graph-schema', () => ({ upsertKnownIssue: jest.fn(async () => {}) }))

// The approve route's session and role checks: the project's owner, approving
// on the project the request names.
jest.mock('@/lib/auth/route-protection', () => ({
  withProjectAccess: (handler: any) => (req: any) =>
    handler(req, { user: { userId: 'u-owner', email: 'owner@backenly.test' }, project: {}, projectId: req.projectId }),
}))
jest.mock('@/lib/edition/guard', () => ({ canWriteProject: jest.fn(async () => true) }))

import { randomBytes } from 'crypto'
import { NOT_QUOTED, findingDetailsKeptHere, quotedError } from '@/lib/data-plane/residency'
import { settleTenantContract, withoutHandlerMessage } from '@/lib/services/contract-verifier'
import { queuePendingActionFinding } from '@/lib/operational-memory/ledger'
import { POST as approve } from '@/app/api/projects/[id]/health/approve/route'

const ROW_ECHO = 'invalid input syntax for type uuid: "alice@example.com"'
// Shaped like nothing real, so the public repository's secret scanner passes it.
const SECRET = 'fixture-supersecret-value-1234567890abcdef'

// Sealing a held action's arguments refuses a short signing secret, as CI's
// is; a random sealing-grade one for this file only, never a literal.
const savedSecret = process.env.JWT_SECRET
beforeAll(() => { process.env.JWT_SECRET = randomBytes(48).toString('base64') })
afterAll(() => { process.env.JWT_SECRET = savedSecret })

function brokenDbProbe() {
  return {
    surface: 'db' as const,
    ok: false,
    critical: true,
    detail: `GET /db/orders returned 500 — ${ROW_ECHO}`,
    status: 500,
    response: JSON.stringify({ message: ROW_ECHO, rows: [{ email: 'alice@example.com' }] }),
    durationMs: 12,
  }
}

const blockAlice = (projectId: string) => ({
  projectId,
  action: 'BLOCK_USER',
  params: { userId: 'u_123', email: 'alice@example.com' },
  target: 'alice@example.com',
  riskLevel: 'medium' as const,
  source: 'brain-risk' as const,
  reason: 'Blocking an end user needs the owner',
})

const forProject = (rows: any[], projectId: string) => rows.filter((row) => row.projectId === projectId)
const auditOf = (projectId: string, action: string) => {
  const row = mockAudits.find((a) => a.projectId === projectId && a.action === action)
  return row ? JSON.parse(row.details) : undefined
}

async function approveFinding(projectId: string, findingId: string) {
  const res: any = await approve({ projectId, json: async () => ({ findingId }) } as any)
  return { status: res.status as number, body: await res.json() }
}

describe('error messages', () => {
  it('keep a home project\'s message, and only an error code for a regional one', () => {
    expect(quotedError(ROW_ECHO, true)).toBe(ROW_ECHO)
    expect(quotedError(ROW_ECHO, false)).toBe(NOT_QUOTED)
    expect(quotedError('MIGRATION_FAILED', false)).toBe('MIGRATION_FAILED')
  })

  it('separate a probe\'s status line from the handler\'s message', () => {
    expect(withoutHandlerMessage(`GET /db/orders returned 500 — ${ROW_ECHO}`)).toBe('GET /db/orders returned 500')
    expect(withoutHandlerMessage('GET /db/orders returned 502')).toBe('GET /db/orders returned 502')
  })
})

describe('a broken contract probe', () => {
  it('keeps the body and the handler message for a home project', async () => {
    mockRegions.set('p-home-contract', null)
    const [finding] = await settleTenantContract('p-home-contract', [], [brokenDbProbe()])
    expect(finding.details.detail).toContain(ROW_ECHO)
    expect(String(finding.details.response)).toContain('alice@example.com')
  })

  it('keeps only the request, status and size for a regional project', async () => {
    mockRegions.set('p-use1-contract', 'us-east-1')
    const probe = brokenDbProbe()
    const [finding] = await settleTenantContract('p-use1-contract', [], [probe])
    expect(finding.details).toMatchObject({
      surface: 'db', detail: 'GET /db/orders returned 500', response: null, responseBytes: probe.response.length, httpStatus: 500,
    })
    expect(JSON.stringify(finding.details)).not.toContain('alice@example.com')
  })
})

describe('a failed repair on a finding', () => {
  const warn = jest.spyOn(console, 'warn').mockImplementation(() => {})
  afterEach(() => warn.mockClear())
  afterAll(() => warn.mockRestore())

  it('is kept as written for a home project', async () => {
    mockRegions.set('p-home-fix', null)
    const details = await findingDetailsKeptHere('p-home-fix', 'missing_index', { location: 'orders', fixError: ROW_ECHO })
    expect(details.fixError).toBe(ROW_ECHO)
    expect(warn).not.toHaveBeenCalled()
  })

  it('keeps only an error code for a regional project, logging the message only where the region is served', async () => {
    mockRegions.set('p-use1-fix', 'us-east-1')
    const saved = process.env.BACKENLY_SERVICE_REGION
    try {
      process.env.BACKENLY_SERVICE_REGION = 'us-east-1'
      const inRegion = await findingDetailsKeptHere('p-use1-fix', 'missing_index', { location: 'orders', fixError: ROW_ECHO })
      expect(inRegion).toEqual({ location: 'orders', fixError: NOT_QUOTED })
      expect(warn).toHaveBeenCalledTimes(1)
      expect(String(warn.mock.calls[0][0])).toContain(ROW_ECHO)

      warn.mockClear()
      delete process.env.BACKENLY_SERVICE_REGION // the home region's process
      const atHome = await findingDetailsKeptHere('p-use1-fix', 'missing_index', { fixError: ROW_ECHO })
      expect(atHome.fixError).toBe(NOT_QUOTED)
      expect(warn).not.toHaveBeenCalled()

      const coded = await findingDetailsKeptHere('p-use1-fix', 'missing_index', { fixError: 'LOCK_TIMEOUT' })
      expect(coded.fixError).toBe('LOCK_TIMEOUT')
    } finally {
      if (saved === undefined) delete process.env.BACKENLY_SERVICE_REGION
      else process.env.BACKENLY_SERVICE_REGION = saved
    }
  })
})

describe('an action held for approval', () => {
  it('names its target on the timeline for a home project', async () => {
    mockRegions.set('p-home-held', null)
    await queuePendingActionFinding(blockAlice('p-home-held'))
    const [event] = forProject(mockEvents, 'p-home-held')
    expect(event.summary).toContain('alice@example.com')
    expect(event.afterState).toEqual({ executorAction: 'BLOCK_USER', target: 'alice@example.com' })
  })

  it('keeps the target for the approver but names only the action on a regional project\'s timeline', async () => {
    mockRegions.set('p-use1-held', 'us-east-1')
    const finding = await queuePendingActionFinding(blockAlice('p-use1-held'))
    const [event] = forProject(mockEvents, 'p-use1-held')
    expect(event.summary).toBe('Held for your approval: Block user.')
    expect(event.afterState).toEqual({ executorAction: 'BLOCK_USER' })
    expect(JSON.stringify(event)).not.toContain('alice@example.com')
    // The approver's copy: what the Review Queue shows and what approval replays.
    expect(mockFindings.get(finding.id).details.location).toBe('alice@example.com')
    expect(mockFindings.get(finding.id).details.executorAction).toBe('BLOCK_USER')
  })
})

describe('approving a held action', () => {
  beforeEach(() => {
    mockExecuted.length = 0
    mockLoop.baseline = async () => { throw new Error(ROW_ECHO) }
  })
  afterEach(() => {
    mockLoop.baseline = async () => ({})
  })

  it('replays the exact arguments and records only their shape, so a secret among them is stored nowhere', async () => {
    mockRegions.set('p-home-ok', null)
    const finding = await queuePendingActionFinding({
      projectId: 'p-home-ok',
      action: 'SET_ENV_VAR',
      params: { key: 'STRIPE_SECRET_KEY', value: SECRET },
      target: 'STRIPE_SECRET_KEY',
      riskLevel: 'medium',
      source: 'brain-risk',
      reason: 'Setting a secret needs the owner',
    })
    const { status } = await approveFinding('p-home-ok', finding.id)

    expect(status).toBe(200)
    expect(mockExecuted).toEqual([{ action: 'SET_ENV_VAR', params: { key: 'STRIPE_SECRET_KEY', value: SECRET, confirmed: true } }])

    const row = mockFindings.get(finding.id)
    expect(row.details).toMatchObject({
      title: 'Set env var on STRIPE_SECRET_KEY',
      location: 'STRIPE_SECRET_KEY',
      executorParams: { key: 'STRIPE_SECRET_KEY', value: '[withheld]' },
    })
    expect(row.details.rollbackData).toMatchObject({
      fixAction: { action: 'SET_ENV_VAR', params: { key: '[string]', value: '[string]', confirmed: true } },
      fixResult: { message: 'SET_ENV_VAR ran on STRIPE_SECRET_KEY', data: { target: 'STRIPE_SECRET_KEY' } },
      baselineError: ROW_ECHO,
    })
    // The secret was replayed and is stored nowhere in the clear.
    expect(JSON.stringify(row)).not.toContain(SECRET)
    expect(JSON.stringify(forProject(mockAudits, 'p-home-ok'))).not.toContain(SECRET)

    expect(auditOf('p-home-ok', 'HEALTH_FIX_EXECUTED').message).toBe('SET_ENV_VAR ran on STRIPE_SECRET_KEY')
    expect(forProject(mockCorrections, 'p-home-ok')[0].correctionDetail.details.location).toBe('STRIPE_SECRET_KEY')
    expect(forProject(mockEvents, 'p-home-ok').map((e) => e.summary)).toEqual([
      'Held for your approval: Set env var on STRIPE_SECRET_KEY.',
      'You approved: Set env var on STRIPE_SECRET_KEY.',
    ])
  })
})
