/**
 * A PLATFORM ROW ABOUT A REGIONAL PROJECT'S WORK QUOTES NONE OF WHAT IT CARRIED
 * =============================================================================
 * The platform database is in the home region. For a project kept in another
 * region, the execution timeline and the operational-memory ledger keep the
 * names, kinds, counts and ids of what was done, never the request, the
 * agent's result, a tool's arguments or an error, any of which can quote its
 * rows or an end user's email (lib/data-plane/residency.ts). A home project's
 * rows are unchanged.
 *
 * Database-free: the platform client is a recorder, and the project's region
 * is whatever the test says it is.
 */

const mockRegions = new Map<string, string | null>()
const mockTimelineRows: any[] = []
const mockTimelineUpdates: any[] = []
const mockEvents: any[] = []
const mockReceipts: any[] = []

jest.mock('@/lib/db/prisma', () => ({
  prisma: {
    project: {
      findUnique: jest.fn(async ({ where }: any) => {
        if (where.id === 'p-broken') throw new Error('connection refused')
        return mockRegions.has(where.id) ? { region: mockRegions.get(where.id) } : null
      }),
    },
    executionTimelineEntry: {
      create: jest.fn(async ({ data }: any) => { mockTimelineRows.push(data); return { id: `t${mockTimelineRows.length}` } }),
      update: jest.fn(async ({ data }: any) => { mockTimelineUpdates.push(data); return data }),
    },
  },
}))

jest.mock('@/lib/db', () => ({
  prisma: {
    backendEvent: {
      create: jest.fn(async ({ data }: any) => { mockEvents.push(data); return { id: `e${mockEvents.length}`, ...data } }),
      updateMany: jest.fn(async () => ({ count: 0 })),
    },
    changeReceipt: {
      create: jest.fn(async ({ data }: any) => { mockReceipts.push(data); return { id: `r${mockReceipts.length}`, ...data } }),
    },
    backendPattern: { upsert: jest.fn(async () => ({})) },
  },
}))

import { NOT_QUOTED, argumentShape, quotesKeptHere } from '@/lib/data-plane/residency'
import { trackAction } from '@/lib/ai/execution-timeline'
import { recordBackendExecutionMemory, recordToolExecutionMemory } from '@/lib/operational-memory/ledger'

const EMAIL = 'alice@example.com'
const flush = () => new Promise((resolve) => setImmediate(resolve))

beforeAll(() => {
  mockRegions.set('p-home', null)
  mockRegions.set('p-mumbai', 'ap-south-1')
  mockRegions.set('p-virginia', 'us-east-1')
  mockRegions.set('p-frankfurt', 'eu-central-1')
  mockRegions.set('p-unknown', 'xx-nowhere-1')
})

beforeEach(() => {
  mockTimelineRows.length = 0
  mockTimelineUpdates.length = 0
  mockEvents.length = 0
  mockReceipts.length = 0
})

describe('whether a platform row may quote a project', () => {
  it('quotes a home project, recorded as the home region or as none', async () => {
    expect(await quotesKeptHere('p-home')).toBe(true)
    expect(await quotesKeptHere('p-mumbai')).toBe(true)
  })

  it('quotes nothing for a project kept in another region', async () => {
    expect(await quotesKeptHere('p-virginia')).toBe(false)
    expect(await quotesKeptHere('p-frankfurt')).toBe(false)
  })

  it('quotes nothing when the region cannot be read, or names no region this build knows', async () => {
    expect(await quotesKeptHere('p-broken')).toBe(false)
    expect(await quotesKeptHere('p-unknown')).toBe(false)
  })
})

describe("a tool's arguments, as a regional project's platform rows keep them", () => {
  it("keeps an insert's table and how many rows, never the rows", () => {
    expect(argumentShape({ table: 'customers', rows: [{ email: EMAIL }, { email: 'bob@example.com' }] }))
      .toEqual({ table: 'customers', rows: { count: 2 } })
  })

  it('keeps an opaque id, and no email, even one passed as an id', () => {
    const id = '2b1c3d4e-0000-4000-8000-000000000001'
    expect(argumentShape({ userId: id, email: EMAIL })).toEqual({ userId: id, email: '[string]' })
    expect(argumentShape({ userId: EMAIL })).toEqual({ userId: '[string]' })
  })

  it('keeps numbers and flags, and anything else only as its kind', () => {
    expect(argumentShape({ limit: 10, cascade: true, values: { name: 'Alice' }, where: `email = '${EMAIL}'` }))
      .toEqual({ limit: 10, cascade: true, values: '[object]', where: '[string]' })
  })

  it('drops a structural name whose value is not an identifier', () => {
    expect(argumentShape({ table: 'customers; drop table x' })).toEqual({ table: '[string]' })
  })
})

describe('the execution timeline', () => {
  const insert = { action: 'INSERT_DATA', params: { table: 'customers', rows: [{ email: EMAIL }] } }

  it('keeps a home project’s arguments and messages as before', async () => {
    await trackAction('p-home', 'run-1', insert, async () => ({ success: false, error: `Key (email)=(${EMAIL}) already exists` }))
    await flush()
    expect(mockTimelineRows[0].actionParams).toEqual(insert.params)
    expect(mockTimelineUpdates[0].errorMessage).toContain(EMAIL)
  })

  it('keeps a regional project’s argument shape and no message, success or failure', async () => {
    await trackAction('p-virginia', 'run-2', insert, async () => ({ success: false, error: `Key (email)=(${EMAIL}) already exists` }))
    await trackAction('p-virginia', 'run-3', insert, async () => ({ success: true, message: `Inserted ${EMAIL}` }))
    await expect(
      trackAction('p-virginia', 'run-4', insert, async () => { throw new Error(`duplicate ${EMAIL}`) }),
    ).rejects.toThrow(EMAIL) // the caller still gets the real error
    await flush()

    expect(mockTimelineRows.map((row) => row.actionParams)).toEqual([
      { table: 'customers', rows: { count: 1 } },
      { table: 'customers', rows: { count: 1 } },
      { table: 'customers', rows: { count: 1 } },
    ])
    expect(mockTimelineUpdates.map((update) => update.errorMessage)).toEqual([NOT_QUOTED, NOT_QUOTED, NOT_QUOTED])
    expect(JSON.stringify([mockTimelineRows, mockTimelineUpdates])).not.toContain(EMAIL)
  })

  it('takes the text out of a regional project’s retry history too', async () => {
    const retryHistory = [{ attempt: 1, errorMessage: `bad ${EMAIL}`, errorClassification: 'UNKNOWN' as const, healingApplied: null, delayMs: 10, timestamp: 't' }]
    await trackAction('p-virginia', 'run-5', insert, async () => ({ success: true }), { retryHistory })
    await flush()
    expect(mockTimelineUpdates[0].healingApplied).toEqual([{ ...retryHistory[0], errorMessage: NOT_QUOTED }])
  })
})

describe('the operational-memory ledger', () => {
  const request = `Block ${EMAIL} and add a notes table`
  const result = `Blocked ${EMAIL}. Created table notes.`

  it('quotes a home project’s request and result as before', async () => {
    await recordToolExecutionMemory({ projectId: 'p-home', userMessage: request, tools: ['create_table'], summary: result })
    expect(mockEvents[0].summary).toContain(EMAIL)
    expect(mockReceipts[0].summary).toContain(request)
    expect(mockReceipts[0].summary).toContain('Result:')
  })

  it('records which tools ran for a regional project, never its request or result', async () => {
    await recordToolExecutionMemory({ projectId: 'p-virginia', userMessage: request, tools: ['create_table'], summary: result })
    expect(mockEvents.map((event) => event.summary)).toEqual(['User asked for a backend change.', expect.any(String)])
    expect(mockReceipts[0].summary).not.toContain('Result:')
    expect(JSON.stringify([mockEvents, mockReceipts])).not.toContain(EMAIL)
  })

  it('records what changed for a regional project, never the request or the intent read from it', async () => {
    await recordBackendExecutionMemory({
      projectId: 'p-frankfurt',
      userMessage: request,
      canonicalIntent: { blockUser: EMAIL },
      changes: [{ type: 'table', action: 'created', target: 'notes', details: { entityName: 'notes' } }],
    })
    expect(mockEvents[0]).toMatchObject({ summary: 'User asked for a backend change.' })
    expect(mockEvents[0].afterState).toBeUndefined()
    expect(mockEvents[1]).toMatchObject({ summary: 'Created table notes', reason: 'Backenly applied this because of the request.' })
    expect(mockReceipts[0]).toMatchObject({ title: 'Created notes backend resource' })
    expect(JSON.stringify([mockEvents, mockReceipts])).not.toContain(EMAIL)
  })
})
