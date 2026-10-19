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
 *   the backfill             regional jobs, run by the region's own worker
 *                            (processRegionalJobs), never by the home queue;
 *                            each batch's starting key is kept in the region,
 *                            and no row at home quotes one
 *   every schema change      a governed change (lib/changes/ledger.ts) whose
 *                            record at home keeps the catalog's structure and
 *                            digests, never its definitions or the SQL that
 *                            ran; the definitions are kept in the region
 */

import { randomBytes, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import { Client } from 'pg'
import { prisma } from '@/lib/db'
import { jwtClaimFunctionSql } from '@/lib/postgrest/rls-translation'
import { disconnectRegionalClients } from '@/lib/data-plane/regional'
import { closeMaintenanceLockPool } from '@/lib/autonomy/maintenance/single-flight'
import { closeChangeLockPool } from '@/lib/changes/lock'
import { closeAllWorkspacePools } from '@/lib/services/workspace-pool'
import { getWorkspaceDatabaseNames } from '@/lib/services/databaseProvisioning'
import { analyzeStructuralEvolution } from '@/lib/structural-evolution'
import { resolveExtractionPlan, isResolveRefusal } from '@/lib/structural-evolution/resolve'
import { grantEvolutionApproval, isGrantRefusal } from '@/lib/structural-evolution/consent'
import { executeExtraction } from '@/lib/structural-evolution/execute'
import { processRegionalJobs } from '@/lib/queue/worker'
import { queueEvolutionBackfill } from '@/lib/structural-evolution/backfill-job'
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
const saved = { mutations: process.env.ENABLE_EVOLUTION_MUTATIONS, engineMode: process.env.ENGINE_MODE }

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

/** The region's own worker, as its scheduler runs it every minute, until the chain ends. */
async function drainInRegion(): Promise<number> {
  let ran = 0
  for (let i = 0; i < 20; i++) {
    const { processed } = await processRegionalJobs('us-east-1')
    if (processed === 0) break
    ran += processed
  }
  return ran
}

beforeAll(async () => {
  if (process.env.NODE_ENV !== 'test') throw new Error('Refusing: NODE_ENV is not test')
  // Schema changes are governed changes, which jest.setup.js switches off.
  process.env.ENGINE_MODE = 'runtime'
  process.env.ENABLE_EVOLUTION_MUTATIONS = 'true'

  regionalUrl = urlFor(REGIONAL_DB)
  await atHome(`CREATE DATABASE "${REGIONAL_DB}"`)
  regionalDbCreated = true
  process.env[REGION_VARIABLE] = regionalUrl
  // What the region's database procedure installs, as project-region.spec.ts
  // sets it up: the table a region keeps its projects' bodies in, a governed
  // change's catalogs among them.
  await inRegion(`CREATE FUNCTION public.backenly_app_role() RETURNS text LANGUAGE sql AS $$ SELECT current_user::text $$`)
  await inRegion(fs.readFileSync('scripts/sql/regional-bodies.sql', 'utf8'))

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
     SELECT $1::uuid, i, CASE WHEN i % 4 = 0 THEN i END, CASE WHEN i % 4 = 0 THEN 'late' END FROM generate_series(1, 2400) i`,
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
  for (const [k, v] of [['ENABLE_EVOLUTION_MUTATIONS', saved.mutations], ['ENGINE_MODE', saved.engineMode]] as const) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  if (projectId) {
    await prisma.backendChange.deleteMany({ where: { projectId } }).catch(() => {})
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
  await closeChangeLockPool()
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
    // Asked of the region, never of the home queue's generic workers.
    const queued = await prisma.backgroundJob.findMany({ where: { projectId, type: 'evolution_backfill' } })
    expect(queued.map(j => [j.status, (j.payload as any).region])).toEqual([['regional_pending', 'us-east-1']])
    expect(await drainInRegion()).toBe(3)
    const done = await executeExtraction({ projectId, planId })
    expect(done.status).toBe('completed')

    const [{ n }] = await inRegion<{ n: string }>(`SELECT count(*)::text AS n FROM ${t('order_refunds')}`)
    expect(n).toBe('600')
    const fwd = await inRegion(`SELECT tgname FROM pg_trigger WHERE tgrelid = $1::regclass AND tgname = $2`, [t('orders'), ladderNames(SPEC).forward])
    expect(fwd).toHaveLength(1)
    expect(await atHome(`SELECT to_regnamespace($1) AS ns`, [schema])).toEqual([{ ns: null }])

    const at = await workspaceAt(projectId)
    const r = await reconcileExtraction(projectId, (await readTableFacts(at, 'orders'))!, SPEC)
    expect(r).toMatchObject({ consistent: true, complete: true, present: 600, satelliteRows: 600 })
  })

  it("kept every batch's starting key in the region, and quoted none at home", async () => {
    const jobs = await prisma.backgroundJob.findMany({ where: { projectId, type: 'evolution_backfill' }, orderBy: { createdAt: 'asc' } })
    expect(jobs.map(j => j.status)).toEqual(['completed', 'completed', 'completed'])
    for (const j of jobs) {
      expect((j.payload as any).cursor).toBeNull()
      expect((j.result as any).cursor).toBeNull()
    }
    // The second and third batches start where the one before stopped: kept there.
    const keys = jobs.map(j => (j.payload as any).cursorKey).filter(Boolean)
    expect(keys).toHaveLength(2)
    const kept = await inRegion<{ id: string; cursor: string }>(
      `SELECT id, payload->>'cursor' AS cursor FROM public.regional_bodies WHERE kind = 'backfill_cursor' AND "projectId" = $1`,
      [projectId],
    )
    expect(kept.map(k => k.id).sort()).toEqual([...keys].sort())
    // Whatever those keys are, no row at home carries one.
    const home = JSON.stringify(await prisma.backgroundJob.findMany({ where: { projectId } })) +
      JSON.stringify(await prisma.maintenanceStepExecution.findMany({ where: { execution: { projectId } } }))
    for (const k of kept) expect(home).not.toContain(k.cursor)
  })

  it('re-queues a batch stopped by a withdrawn consent exactly where it stopped, in the region', async () => {
    // A paused chain's last payload names its cursor in the region; resuming
    // queues that payload again (execute.ts) and must not lose the key.
    await inRegion(
      `INSERT INTO public.regional_bodies (kind, id, "projectId", payload) VALUES ('backfill_cursor', 'resume-probe', $1, '{"cursor": "k"}')`,
      [projectId],
    )
    const job = await queueEvolutionBackfill({
      projectId, planId, planVersion: 'v-probe', basisFingerprint: 'x', spec: SPEC, cursor: null, cursorKey: 'resume-probe',
    })
    const row = await prisma.backgroundJob.findUnique({ where: { id: job.id } })
    expect(row).toMatchObject({ status: 'regional_pending' })
    expect(row!.payload).toMatchObject({ region: 'us-east-1', cursor: null, cursorKey: 'resume-probe' })
    await prisma.backgroundJob.delete({ where: { id: job.id } })
  })

  it('records every schema change at home by its structure, with the definitions kept in the region', async () => {
    const changes = await prisma.backendChange.findMany({
      where: { projectId },
      orderBy: { seq: 'asc' },
      select: { id: true, title: true, status: true, source: true, statements: true, checkpoint: true },
    })
    expect(changes.map(c => c.status)).toEqual(['healthy', 'healthy', 'healthy', 'healthy'])
    for (const c of changes) {
      expect(c.source).toBe('approval')
      // Names only in the title; no SQL kept at home; the definitions in the region.
      expect(c.title).toMatch(/^Architecture change \(refund of orders\), step \d+: /)
      expect(c.statements).toEqual([])
      expect((c.checkpoint as { definitionsInRegion?: boolean }).definitionsInRegion).toBe(true)
      expect(JSON.stringify(c.checkpoint)).not.toMatch(/refund_amount >= 0|backenly_jwt_claim\(/)
    }
    const kept = await inRegion<{ id: string }>(
      `SELECT id FROM public.regional_bodies WHERE kind = 'change_catalog' AND "projectId" = $1 ORDER BY id`,
      [projectId],
    )
    expect(kept.map(k => k.id).sort()).toEqual(changes.map(c => c.id).sort())
  })

  it('is undone in the region, as one governed change', async () => {
    const out = await rollbackExtraction({ projectId, planId, requestedBy: ownerId })
    expect(out.status).toBe('rolled_back')
    expect(await inRegion(`SELECT to_regclass($1) AS r`, [t('order_refunds')])).toEqual([{ r: null }])
    expect(await inRegion(`SELECT tgname FROM pg_trigger WHERE tgrelid = $1::regclass AND NOT tgisinternal`, [t('orders')])).toEqual([])
    const undo = await prisma.backendChange.findFirst({
      where: { projectId, title: { startsWith: 'Undo architecture change' } },
      select: { status: true, source: true, actorUserId: true, statements: true },
    })
    expect(undo).toMatchObject({ status: 'healthy', source: 'dashboard', actorUserId: ownerId, statements: [] })
  })
})
