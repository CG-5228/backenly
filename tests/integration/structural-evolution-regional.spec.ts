/**
 * AN EXTRACTION OF A PROJECT KEPT IN ANOTHER REGION HAPPENS IN THAT REGION
 * ========================================================================
 * Backenly Cloud keeps each project's workspace schema in its own region's
 * database (lib/data-plane/regional.ts). Postgres accepts a schema missing from
 * the search path without complaint, so an extraction that sent a statement to
 * the home database instead would not fail: it would read an empty catalog, or
 * worse. This suite creates a second database as the stand-in for us-east-1,
 * puts one project's tables ONLY there, and runs an extraction end to end:
 *
 *   analysis, the plan, the rehearsal, every rung, the backfill, reconciliation
 *   and undo                 read and write the regional database; the home
 *                            database never holds the project's schema
 */

import { randomBytes, randomUUID } from 'node:crypto'
import { Client } from 'pg'
import { prisma } from '@/lib/db'
import { jwtClaimFunctionSql } from '@/lib/postgrest/rls-translation'
import { disconnectRegionalClients } from '@/lib/data-plane/regional'
import { closeMaintenanceLockPool } from '@/lib/autonomy/maintenance/single-flight'
import { closeAllWorkspacePools } from '@/lib/services/workspace-pool'
import { getWorkspaceDatabaseNames } from '@/lib/services/databaseProvisioning'
import { analyzeStructuralEvolution } from '@/lib/structural-evolution'
import { resolveExtractionPlan, isResolveRefusal } from '@/lib/structural-evolution/resolve'
import { grantEvolutionApproval, isGrantRefusal } from '@/lib/structural-evolution/consent'
import { executeExtraction } from '@/lib/structural-evolution/execute'
import { handleEvolutionBackfillJob } from '@/lib/structural-evolution/backfill-job'
import { reconcileExtraction } from '@/lib/structural-evolution/reconcile'
import { rollbackExtraction } from '@/lib/structural-evolution/rollback'
import { readTableFacts } from '@/lib/structural-evolution/facts'
import { workspaceAt } from '@/lib/structural-evolution/workspace'
import { ladderNames, type ExtractionSpec } from '@/lib/structural-evolution/sql'

jest.setTimeout(300_000)

const REGION_VARIABLE = 'DATABASE_URL_US_EAST_1'
const REGIONAL_DB = `backenly_evo_region_${randomBytes(4).toString('hex')}`
const ROLE = `bkn_evo_rg_${randomBytes(4).toString('hex')}`
const USER_A = randomUUID()
const SPEC: ExtractionSpec = { host: 'orders', members: ['refund_amount', 'refund_reason'], satellite: 'order_refunds', label: 'refund' }

let regionalUrl = ''
let regionalDbCreated = false
let ownerId = ''
let projectId = ''
let schema = ''
let planId = ''
const saved = { mutations: process.env.ENABLE_EVOLUTION_MUTATIONS }

const homeUrl = () => process.env.DATABASE_URL as string

function urlFor(database: string): string {
  const url = new URL(homeUrl())
  url.pathname = `/${database}`
  return url.toString()
}

async function on<T = any>(connectionString: string, sql: string, params: unknown[] = []): Promise<T[]> {
  const client = new Client({ connectionString })
  await client.connect()
  try {
    return (await client.query(sql, params)).rows as T[]
  } finally {
    await client.end().catch(() => {})
  }
}
const inRegion = <T = any>(sql: string, params: unknown[] = []) => on<T>(regionalUrl, sql, params)
const atHome = <T = any>(sql: string, params: unknown[] = []) => on<T>(homeUrl(), sql, params)
const t = (name: string) => `"${schema}"."${name}"`

/** The project's backfill batches, run where the job queue would run them. */
async function drainBackfill(): Promise<number> {
  let ran = 0
  for (let i = 0; i < 50; i++) {
    const job = await prisma.backgroundJob.findFirst({
      where: { projectId, type: 'evolution_backfill', status: { in: ['queued', 'regional_pending'] } },
      orderBy: { createdAt: 'asc' },
    })
    if (!job) break
    const result = await handleEvolutionBackfillJob(job.payload as any)
    await prisma.backgroundJob.update({ where: { id: job.id }, data: { status: 'completed', result: result as object, completedAt: new Date() } })
    ran++
  }
  return ran
}

beforeAll(async () => {
  if (process.env.NODE_ENV !== 'test') throw new Error('Refusing: NODE_ENV is not test')
  process.env.ENABLE_EVOLUTION_MUTATIONS = 'true'

  regionalUrl = urlFor(REGIONAL_DB)
  await atHome(`CREATE DATABASE "${REGIONAL_DB}"`)
  regionalDbCreated = true
  process.env[REGION_VARIABLE] = regionalUrl

  ownerId = (await prisma.user.create({
    data: { email: `evo-rg-${randomBytes(6).toString('hex')}@example.test`, password: 'not-a-real-hash', name: 'evo region' },
  })).id
  projectId = (await prisma.project.create({ data: { name: 'evolution-regional', userId: ownerId, region: 'us-east-1' } })).id
  schema = getWorkspaceDatabaseNames(projectId).postgresSchema
  await prisma.workspace.create({ data: { name: 'evolution regional', projectId, postgresSchema: schema, databaseProvisioned: true } })

  const svc = `${t('backenly_jwt_claim')}('role') = 'service_role'`
  const sub = `${t('backenly_jwt_claim')}('sub')`
  await inRegion(`CREATE SCHEMA "${schema}"`)
  await inRegion(jwtClaimFunctionSql(schema))
  await inRegion(`CREATE TABLE ${t('orders')} (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL,
    total numeric NOT NULL,
    refund_amount numeric CHECK (refund_amount >= 0),
    refund_reason text
  )`)
  await inRegion(
    `INSERT INTO ${t('orders')} (user_id, total, refund_amount, refund_reason)
     SELECT $1::uuid, i, CASE WHEN i % 4 = 0 THEN i END, CASE WHEN i % 4 = 0 THEN 'late' END FROM generate_series(1, 120) i`,
    [USER_A],
  )
  await inRegion(`ALTER TABLE ${t('orders')} ENABLE ROW LEVEL SECURITY`)
  await inRegion(`ALTER TABLE ${t('orders')} FORCE ROW LEVEL SECURITY`)
  await inRegion(`CREATE POLICY orders_rw ON ${t('orders')} FOR ALL USING (${svc} OR user_id::text = ${sub}) WITH CHECK (${svc} OR user_id::text = ${sub})`)
  await atHome(`CREATE ROLE "${ROLE}" NOLOGIN NOSUPERUSER`)
  await inRegion(`GRANT USAGE ON SCHEMA "${schema}" TO "${ROLE}"`)
  await inRegion(`GRANT SELECT, UPDATE ON ${t('orders')} TO "${ROLE}"`)
}, 120_000)

afterAll(async () => {
  for (const [k, v] of [['ENABLE_EVOLUTION_MUTATIONS', saved.mutations]] as const) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  if (projectId) {
    await prisma.maintenanceStepExecution.deleteMany({ where: { execution: { projectId } } }).catch(() => {})
    await prisma.maintenanceExecution.deleteMany({ where: { projectId } }).catch(() => {})
    await prisma.maintenanceApproval.deleteMany({ where: { projectId } }).catch(() => {})
    await prisma.backgroundJob.deleteMany({ where: { projectId } }).catch(() => {})
    await prisma.workspaceSchemaSnapshot.deleteMany({ where: { projectId } }).catch(() => {})
    await prisma.table.deleteMany({ where: { projectId } }).catch(() => {})
    await prisma.workspace.deleteMany({ where: { projectId } }).catch(() => {})
    await prisma.project.deleteMany({ where: { id: projectId } }).catch(() => {})
  }
  if (ownerId) await prisma.user.delete({ where: { id: ownerId } }).catch(() => {})
  await closeMaintenanceLockPool()
  await closeAllWorkspacePools()
  await disconnectRegionalClients()
  delete process.env[REGION_VARIABLE]
  if (regionalDbCreated) await atHome(`DROP DATABASE IF EXISTS "${REGIONAL_DB}" WITH (FORCE)`).catch(() => {})
  await atHome(`DROP ROLE IF EXISTS "${ROLE}"`).catch(() => {})
}, 120_000)

describe('a project kept in us-east-1', () => {
  it('has no schema at home: anything sent there would find nothing', async () => {
    expect(await atHome(`SELECT to_regnamespace($1) AS ns`, [schema])).toEqual([{ ns: null }])
    expect(await inRegion(`SELECT to_regnamespace($1)::text AS ns`, [schema])).toEqual([{ ns: `"${schema}"` }])
  })

  it('is analysed from its own region', async () => {
    const report = await analyzeStructuralEvolution(projectId)
    expect(report.tables.map(x => x.table)).toEqual(['orders'])
  })

  it('is planned, rehearsed and approved from its own catalog', async () => {
    const resolved = await resolveExtractionPlan(projectId, SPEC)
    if (isResolveRefusal(resolved)) throw new Error(resolved.refusal)
    expect(resolved.plan.validity).toBe('executable')
    expect(resolved.plan.schema).toBe(schema)
    planId = resolved.plan.planId
    const granted = await grantEvolutionApproval({
      projectId, spec: SPEC, planVersion: resolved.plan.planVersion, approvedBy: ownerId, resolve: resolveExtractionPlan,
    })
    if (isGrantRefusal(granted)) throw new Error(granted.error)
  })

  it('runs every rung in the region, and nothing at home', async () => {
    const first = await executeExtraction({ projectId, planId })
    expect(first.status).toBe('awaiting_background_work')
    expect(first.steps.map(s => [s.kind, s.status])).toEqual([
      ['rehearse', 'completed'],
      ['create_satellite', 'completed'],
      ['sync_forward', 'completed'],
      ['backfill', 'dispatched'],
    ])
    expect(await drainBackfill()).toBeGreaterThanOrEqual(1)
    const done = await executeExtraction({ projectId, planId })
    expect(done.status).toBe('completed')

    const [{ n }] = await inRegion<{ n: string }>(`SELECT count(*)::text AS n FROM ${t('order_refunds')}`)
    expect(n).toBe('30')
    const fwd = await inRegion(`SELECT tgname FROM pg_trigger WHERE tgrelid = $1::regclass AND tgname = $2`, [t('orders'), ladderNames(SPEC).forward])
    expect(fwd).toHaveLength(1)
    expect(await atHome(`SELECT to_regnamespace($1) AS ns`, [schema])).toEqual([{ ns: null }])

    const at = await workspaceAt(projectId)
    const r = await reconcileExtraction(projectId, (await readTableFacts(at, 'orders'))!, SPEC)
    expect(r).toMatchObject({ consistent: true, complete: true, present: 30, satelliteRows: 30 })
  })

  it('is undone in the region', async () => {
    const out = await rollbackExtraction({ projectId, planId, requestedBy: ownerId })
    expect(out.status).toBe('rolled_back')
    expect(await inRegion(`SELECT to_regclass($1) AS r`, [t('order_refunds')])).toEqual([{ r: null }])
    expect(await inRegion(`SELECT tgname FROM pg_trigger WHERE tgrelid = $1::regclass AND NOT tgisinternal`, [t('orders')])).toEqual([])
  })
})
