/** A PostgreSQL DDL failure must never let a model substitute another action. */
import crypto from 'crypto'
import { prisma } from '@/lib/db/prisma'
import { createProvisionedProject } from '@/lib/projects/provision'
import { applyMigrationToMain } from '@/lib/mcp/apply-migration'

// Only the external model is stubbed. All project rows, DDL and catalog reads
// use PostgreSQL through the real migration dispatch and executor.
jest.mock('@/lib/ai/openai-service', () => ({
  getOpenAIClient: jest.fn(),
  trackCompletionCost: jest.fn(),
}))
import { getOpenAIClient } from '@/lib/ai/openai-service'

let ownerId: string
let projectId: string
let schema: string
const originalEngineMode = process.env.ENGINE_MODE
const originalEdition = process.env.BACKENLY_EDITION

beforeAll(async () => {
  process.env.ENGINE_MODE = 'runtime'
  process.env.BACKENLY_EDITION = 'cloud'
  ownerId = (await prisma.user.create({
    data: { email: `migration-dispatch-${crypto.randomUUID()}@example.test`, password: 'test-only-hash', name: 'migration dispatch' },
  })).id
  const project = await createProvisionedProject({ name: 'migration-dispatch', userId: ownerId })
  projectId = project.id
  schema = project.postgresSchema
  await prisma.project.update({ where: { id: projectId }, data: { protectedProduction: false } })
  const created = await applyMigrationToMain(projectId, ownerId, 'CREATE TABLE posts (title text)', {
    workspaceSchema: schema, agentSurface: true,
  })
  expect(created.ok).toBe(true)
  await prisma.$executeRawUnsafe(`INSERT INTO "${schema}".posts (title) VALUES ('duplicate'), ('duplicate')`)
}, 120_000)

afterAll(async () => {
  if (schema) await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
  if (ownerId) {
    await prisma.project.deleteMany({ where: { userId: ownerId } })
    await prisma.user.delete({ where: { id: ownerId } })
  }
  if (originalEngineMode === undefined) delete process.env.ENGINE_MODE
  else process.env.ENGINE_MODE = originalEngineMode
  if (originalEdition === undefined) delete process.env.BACKENLY_EDITION
  else process.env.BACKENLY_EDITION = originalEdition
}, 60_000)

it('returns the real DDL error, preserves rows and stops before the next statement without replanning', async () => {
  const model = jest.mocked(getOpenAIClient)
  model.mockClear()
  model.mockReturnValue({ chat: { completions: { create: jest.fn().mockResolvedValue({
    choices: [{ message: { content: JSON.stringify({
      action: 'CREATE_TABLE',
      params: { tableName: 'replacement_table', columns: [{ name: 'body', type: 'TEXT' }] },
    }) } }],
  }) } } } as unknown as ReturnType<typeof getOpenAIClient>)

  const statement = 'CREATE UNIQUE INDEX posts_title_unique ON posts (title)'
  const nextStatement = 'CREATE TABLE comments (body text)'
  const result = await applyMigrationToMain(projectId, ownerId, `${statement}; ${nextStatement}`, {
    workspaceSchema: schema, agentSurface: true,
  })

  expect(model).not.toHaveBeenCalled()
  expect(result).toMatchObject({
    ok: false, code: 'MIGRATION_FAILED', error: `Migration stopped at: ${statement}`,
    detail: expect.stringMatching(/duplicate|unique index/i), applied: [], remaining: [nextStatement],
  })
  const indexes = await prisma.$queryRaw<Array<{ indexname: string }>>`
    SELECT indexname FROM pg_indexes WHERE schemaname = ${schema} AND indexname = 'posts_title_unique'`
  expect(indexes).toEqual([])
  const tables = await prisma.$queryRaw<Array<{ table_name: string }>>`
    SELECT table_name FROM information_schema.tables WHERE table_schema = ${schema}`
  expect(tables.map((row) => row.table_name)).not.toEqual(expect.arrayContaining(['comments']))
  expect(tables.map((row) => row.table_name)).not.toEqual(expect.arrayContaining(['replacement_table']))
  const rows = await prisma.$queryRawUnsafe<Array<{ title: string }>>(`SELECT title FROM "${schema}".posts`)
  expect(rows).toEqual([{ title: 'duplicate' }, { title: 'duplicate' }])
}, 60_000)
