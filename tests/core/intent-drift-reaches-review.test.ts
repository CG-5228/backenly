/**
 * INTENT DRIFT REACHES A PERSON — AND ONLY REAL DRIFT DOES
 * ========================================================
 * The per-minute loop evaluates `the_schema_is_what_was_asked_for`, but like
 * every notify_only gap it never mints a finding for it: the reconciler persists
 * only what it would repair on its own. The observer is the path that persists
 * non-auto findings, and it did not run this check. So a column dropped behind
 * Backenly's back was detected every minute and recorded nowhere; nobody was
 * told, and the AI investigator, which reads findings, never saw one. Measured
 * on staging 2026-10-12: 25 loop ticks after the drop, no finding.
 *
 * The other half: nothing ever superseded the ledger, so Backenly's own drops
 * and renames left the old request in place. Recording drift as it stood would
 * have reported every deliberate drop as a missing column, and an AI proposal
 * would have offered to put it back.
 *
 * Real PostgreSQL, the real observer and the real executor.
 */

import { PrismaClient } from '@prisma/client'
import { randomUUID } from 'crypto'
import { recordSchemaIntent } from '@/lib/autonomy/intent-conformance'
import { runObserverForProject } from '@/lib/services/workspace-observer'
import { executeAction } from '@/lib/ai/minimal-executor'

const prisma = new PrismaClient()
const userId = randomUUID()
const projectId = randomUUID()
const schema = `workspace_${projectId}`
const raw = (sql: string) => prisma.$executeRawUnsafe(sql)

const openDrift = async (location: string) =>
  prisma.healthFinding.findMany({
    where: { projectId, type: 'intent_drift', status: { in: ['open', 'pending_approval'] }, details: { path: ['location'], equals: location } },
  })
// An approved action from the Review Queue, run the way the executor runs it.
const governed = (action: string, params: Record<string, unknown>) =>
  executeAction({ action, params: { ...params, confirmed: true } } as any, projectId, undefined, 0, undefined, false)

beforeAll(async () => {
  await prisma.user.create({ data: { id: userId, email: `drift-review+${userId.slice(0, 8)}@backenly.test`, name: 'drift', password: 'x' } })
  await prisma.project.create({ data: { id: projectId, name: 'intent-drift-review', userId, jwtSecret: 'a'.repeat(64) } })
  // Registered tables are what make a project watchable by the observer.
  await prisma.table.create({ data: { name: 'orders', projectId } })
  await prisma.table.create({ data: { name: 'items', projectId } })
  await raw(`CREATE SCHEMA "${schema}"`)
  await raw(`CREATE TABLE "${schema}".orders (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), total numeric, placed_at timestamptz, shipped_at timestamptz)`)
  await raw(`CREATE TABLE "${schema}".items (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), note text, label text, sku text)`)
  await recordSchemaIntent(projectId, 'orders', [
    { name: 'total', type: 'numeric' }, { name: 'placed_at', type: 'timestamp' }, { name: 'shipped_at', type: 'timestamp' },
  ], 'create_table')
  await recordSchemaIntent(projectId, 'items', [
    { name: 'note', type: 'text' }, { name: 'label', type: 'text' }, { name: 'sku', type: 'text' },
  ], 'create_table')
}, 60_000)

afterAll(async () => {
  await raw(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {})
  await prisma.healthFinding.deleteMany({ where: { projectId } }).catch(() => {})
  await prisma.schemaIntent.deleteMany({ where: { projectId } }).catch(() => {})
  await prisma.project.delete({ where: { id: projectId } }).catch(() => {})
  await prisma.user.delete({ where: { id: userId } }).catch(() => {})
  await prisma.$disconnect()
}, 60_000)

describe("a column dropped behind Backenly's back", () => {
  test('the observer records it, waiting on a person', async () => {
    await raw(`ALTER TABLE "${schema}".orders DROP COLUMN placed_at`)
    await runObserverForProject(projectId)
    const rows = await openDrift('orders.placed_at')
    expect(rows).toHaveLength(1)
    expect(rows[0].status).toBe('pending_approval')
    expect((rows[0].details as any).driftKind).toBe('missing_column')
  }, 120_000)

  test('a second scan keeps one row for it', async () => {
    await runObserverForProject(projectId)
    expect(await openDrift('orders.placed_at')).toHaveLength(1)
  }, 120_000)

  test('a second missing column is its own row, not a replacement', async () => {
    await raw(`ALTER TABLE "${schema}".orders DROP COLUMN shipped_at`)
    await runObserverForProject(projectId)
    expect(await openDrift('orders.placed_at')).toHaveLength(1)
    expect(await openDrift('orders.shipped_at')).toHaveLength(1)
  }, 120_000)
})

describe('a change made through Backenly is not drift', () => {
  test('a governed column drop supersedes the request', async () => {
    const r = await governed('DROP_COLUMN', { tableName: 'items', columnName: 'note' })
    expect(r.success).toBe(true)
    expect(await prisma.schemaIntent.count({ where: { projectId, tableName: 'items', columnName: 'note' } })).toBe(0)
    await runObserverForProject(projectId)
    expect(await openDrift('items.note')).toHaveLength(0)
  }, 120_000)

  test('a governed rename moves the request with the column', async () => {
    const r = await governed('RENAME_COLUMN', { tableName: 'items', oldName: 'label', newName: 'title' })
    expect(r.success).toBe(true)
    expect(await prisma.schemaIntent.count({ where: { projectId, tableName: 'items', columnName: 'label' } })).toBe(0)
    const moved = await prisma.schemaIntent.findMany({ where: { projectId, tableName: 'items', columnName: 'title' } })
    expect(moved.map((i) => i.requestedType)).toEqual(['text'])
    await runObserverForProject(projectId)
    expect(await openDrift('items.label')).toHaveLength(0)
    expect(await openDrift('items.title')).toHaveLength(0)
  }, 120_000)

  test('a governed table drop supersedes every request on it', async () => {
    const r = await governed('DROP_TABLE', { tableName: 'items' })
    expect(r.success).toBe(true)
    expect(await prisma.schemaIntent.count({ where: { projectId, tableName: 'items' } })).toBe(0)
  }, 120_000)

  test('the out-of-band drift is still reported after all of that', async () => {
    await runObserverForProject(projectId)
    expect(await openDrift('orders.placed_at')).toHaveLength(1)
  }, 120_000)
})
