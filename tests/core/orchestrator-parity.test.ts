/**
 * BEFORE THE AGENT ORCHESTRATOR LEAVES THE LOOP, THE CANONICAL DETECTORS COVER IT
 * ===============================================================================
 *
 * The background monitor runs a second detect-and-fix pipeline beside the
 * canonical one (desired-state -> reconciler -> auto-fix kernel -> re-check):
 * four "agents" in lib/ai/agents. Retiring it is only safe if every real
 * problem it can find is found canonically, and if none of its false findings
 * is repeated there. Each section below is one of its checks, run against a
 * real PostgreSQL schema:
 *
 *   security    missing_rls        canonical catches what it misses, and does
 *                                   not repeat its deny-all misreading
 *   security    auth_gap           canonical files auth findings only on evidence
 *   performance missing_index      canonical catches FK columns by constraint,
 *               n_plus_one_risk    including the junction-table columns
 *   repair      orphaned_fk        the condition cannot exist in PostgreSQL
 *   repair      realtime triggers  a table without one has realtime off; there
 *                                   is no defect to detect
 *
 * The migration agent's drift check and the security agent's model review are
 * covered in docs/autonomy-orchestrator-parity.md; the drift detectors that
 * replace it have their own suites.
 *
 * The agents themselves are deleted. The sections that ran them, to show each
 * false finding happening rather than asserting it from the agent's code, left
 * with them; what they showed is recorded in docs/autonomy-orchestrator-parity.md.
 * The canonical halves stay, so a canonical detector that stops covering one of
 * these cases fails here.
 */

import { PrismaClient } from '@prisma/client'
import { randomUUID } from 'crypto'
import { detectMissingRls, detectRlsDeniesEverything } from '@/lib/services/workspace-observer'
import { detectMissingFkIndexes, checkAuthIntegrity } from '@/lib/core/drift-detector'
import { probeCoveredTypes } from '@/lib/autonomy/desired-state'

// The security agent ends with a model review. Without a key it cannot run, so
// these tests never reach a provider.
delete process.env.OPENAI_API_KEY

const prisma = new PrismaClient()
const q = (sql: string) => prisma.$executeRawUnsafe(sql)

let userId: string
let projectId: string
let schema: string

/** Create a table a client role can read, as every platform table is. */
async function table(name: string, columns: string) {
  await q(`CREATE TABLE "${schema}"."${name}" (${columns})`)
  await q(`GRANT SELECT ON "${schema}"."${name}" TO authenticated`).catch(() => {})
}

beforeAll(async () => {
  userId = randomUUID()
  projectId = randomUUID()
  schema = `workspace_${projectId}`

  await prisma.user.create({
    data: { id: userId, email: `parity+${userId.slice(0, 8)}@backenly.test`, name: 'parity', password: 'not-a-real-hash' },
  })
  await prisma.project.create({ data: { id: projectId, name: 'orchestrator-parity', userId } as any })
  await q(`CREATE SCHEMA "${schema}"`)

  // RLS
  await table('invoices', 'id uuid PRIMARY KEY, total numeric')
  await table('payments', 'id uuid PRIMARY KEY, amount numeric')
  await q(`CREATE POLICY payments_read ON "${schema}"."payments" FOR SELECT USING (true)`)
  await table('orders', 'id uuid PRIMARY KEY')
  await q(`ALTER TABLE "${schema}"."orders" ENABLE ROW LEVEL SECURITY`)

  // Foreign keys and indexes
  await table('posts', 'id uuid PRIMARY KEY')
  await table('people', 'id uuid PRIMARY KEY')
  await table('tags', 'id uuid PRIMARY KEY')
  await table('comments', `id uuid PRIMARY KEY, post_id uuid REFERENCES "${schema}"."posts"(id)`)
  await table('entries', `id uuid PRIMARY KEY, author uuid REFERENCES "${schema}"."people"(id)`)
  await table('ledger', 'id uuid PRIMARY KEY, account_id uuid, created_at timestamptz')
  await q(`CREATE INDEX ledger_account_created ON "${schema}"."ledger" (account_id, created_at)`)
  await table('flags', 'id uuid PRIMARY KEY, paid boolean, uuid text')
  await table(
    'post_tags',
    `post_id uuid REFERENCES "${schema}"."posts"(id), tag_id uuid REFERENCES "${schema}"."tags"(id)`,
  )
}, 120_000)

afterAll(async () => {
  await q(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {})
  await prisma.permissionPolicy.deleteMany({ where: { projectId } }).catch(() => {})
  await prisma.healthFinding.deleteMany({ where: { projectId } }).catch(() => {})
  await prisma.project.deleteMany({ where: { id: projectId } }).catch(() => {})
  await prisma.user.deleteMany({ where: { id: userId } }).catch(() => {})
  await prisma.$disconnect()
}, 120_000)

const tablesIn = (findings: Array<{ details?: Record<string, unknown> | null }>) =>
  new Set(findings.map((f) => String(f.details?.tableName ?? '')))

// ── security: missing_rls ─────────────────────────────────────────────────────

describe('row security', () => {
  it('canonical catches exposed tables the name-based check never looks at', async () => {
    const exposed = tablesIn(await detectMissingRls(projectId))
    // Not on the security agent's list of sensitive names.
    expect(exposed.has('invoices')).toBe(true)
    // Has a policy, but RLS is off, so the policy is not applied to anything.
    expect(exposed.has('payments')).toBe(true)
  }, 60_000)

  it('canonical reads RLS-on-with-no-policy as denying everyone, not as exposed', async () => {
    expect(tablesIn(await detectMissingRls(projectId)).has('orders')).toBe(false)
    expect(tablesIn(await detectRlsDeniesEverything(projectId)).has('orders')).toBe(true)
  }, 60_000)

})

// ── security: auth_gap ────────────────────────────────────────────────────────

describe('end-user auth', () => {
  it('canonical files nothing for a project that does not use end-user auth', async () => {
    const types = (await checkAuthIntegrity(projectId)).map((f) => f.type)
    expect(types).not.toContain('auth_users_table_missing')
    expect(types).not.toContain('auth_jwt_missing')
  }, 60_000)

  it('canonical files the missing users table once auth is configured', async () => {
    await prisma.permissionPolicy.create({
      data: { projectId, tableName: 'users', policyName: 'own_row', operation: 'SELECT', using: 'id = current_user_id()' },
    })
    const types = (await checkAuthIntegrity(projectId)).map((f) => f.type)
    expect(types).toContain('auth_users_table_missing')
    await prisma.permissionPolicy.deleteMany({ where: { projectId } })
  }, 60_000)
})

// ── performance: missing_index, n_plus_one_risk ──────────────────────────────

describe('foreign-key indexes', () => {
  let found: Map<string, Record<string, unknown>>

  beforeAll(async () => {
    const findings = await detectMissingFkIndexes(projectId)
    found = new Map(
      findings.map((f) => [`${f.details?.tableName}.${f.details?.columnName}`, f.details as Record<string, unknown>]),
    )
  }, 60_000)

  it('catches an unindexed foreign key by its constraint', () => {
    expect(found.get('comments.post_id')?.basis).toBe('foreign_key')
  })

  it('catches one whose column is not named *_id', () => {
    // The old rule went by the column's name. The performance agent read the
    // constraint, so this is the case the canonical check had to gain.
    expect(found.get('entries.author')?.basis).toBe('foreign_key')
  })

  it('catches both reference columns of a junction table, the real cause of its N+1 cost', () => {
    expect(found.has('post_tags.post_id')).toBe(true)
    expect(found.has('post_tags.tag_id')).toBe(true)
  })

  it('counts a composite index that leads with the column as covering it', () => {
    expect(found.has('ledger.account_id')).toBe(false)
  })

  it('does not read "paid" or "uuid" as reference columns', () => {
    expect(found.has('flags.paid')).toBe(false)
    expect(found.has('flags.uuid')).toBe(false)
  })

  it('does not flag primary keys', () => {
    expect([...found.keys()].some((k) => k.endsWith('.id'))).toBe(false)
  })
})

// ── repair: orphaned_fk ──────────────────────────────────────────────────────

describe('a foreign key to a table that no longer exists', () => {
  it('cannot exist: PostgreSQL refuses the drop, and CASCADE removes the constraint with it', async () => {
    await table('parity_owner', 'id uuid PRIMARY KEY')
    await table('parity_child', `id uuid PRIMARY KEY, owner_ref uuid REFERENCES "${schema}"."parity_owner"(id)`)

    await expect(q(`DROP TABLE "${schema}"."parity_owner"`)).rejects.toThrow(/depend/i)

    await q(`DROP TABLE "${schema}"."parity_owner" CASCADE`)
    const remaining = await prisma.$queryRawUnsafe<Array<{ n: bigint }>>(
      `SELECT count(*)::bigint AS n FROM pg_constraint c
         JOIN pg_class t ON t.oid = c.conrelid
         JOIN pg_namespace n ON n.oid = t.relnamespace
        WHERE n.nspname = '${schema}' AND t.relname = 'parity_child' AND c.contype = 'f'`,
    )
    expect(Number(remaining[0].n)).toBe(0)
  }, 60_000)
})

// ── repair: realtime triggers ────────────────────────────────────────────────

describe('realtime triggers', () => {
  it('canonical has no realtime finding to repeat it with', () => {
    // Turning realtime on for a table IS installing its trigger
    // (lib/services/realtimeTriggers.ts), so no trigger means realtime is off,
    // which is a choice, and there is no recorded intent to compare against.
    expect([...probeCoveredTypes()].filter((t) => t.includes('realtime'))).toEqual([])
  })
})
