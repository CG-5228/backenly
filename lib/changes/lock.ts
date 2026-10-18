/**
 * One schema change per project at a time.
 *
 * A change is recorded as the difference between the catalog before it and the
 * catalog after it (lib/changes/ledger.ts). That is only true if nothing else
 * changed the schema in between: two agents migrating one project at once would
 * each record the other's tables as their own, and restoring one would undo
 * both. So every governed change, every recovery and every recovery preview
 * holds this lock for as long as it runs.
 *
 * Same construction as lib/autonomy/maintenance/single-flight.ts, for the same
 * reasons: a PostgreSQL advisory lock, because the database decides it
 * atomically across every instance; session-scoped, on a connection that stays
 * checked out until release, because an unlock on a different pooled
 * connection silently does nothing; the two-integer keyspace with a namespace
 * of its own, so it never collides with the build lock or the maintenance lock.
 *
 * Unlike the maintenance sweep it WAITS, up to a bound. A change is a person or
 * an agent waiting on an answer, and a migration that arrives while another is
 * applying should run after it, not fail. Past the bound it is refused with
 * CHANGE_IN_PROGRESS rather than queued indefinitely.
 *
 * Re-entrant within one async context: a rollback started while a change holds
 * the lock (the automatic rollback of a migration that failed part-way) runs on
 * the same connection instead of deadlocking against itself.
 */

import { AsyncLocalStorage } from 'async_hooks'
import { Pool, type PoolClient } from 'pg'
import { projectToLockKey } from '@/lib/autonomy/maintenance/single-flight'
import { readCatalog, type CatalogSnapshot } from './catalog'

/** 'chng'. Fixed: changing it would let an old and a new instance both hold a project. */
const CHANGE_LOCK_NAMESPACE = 0x63686e67

const DEFAULT_WAIT_MS = 30_000

export class ChangeInProgressError extends Error {
  readonly code = 'CHANGE_IN_PROGRESS'
  constructor() {
    super('Another schema change is being applied to this project right now. Try again in a moment.')
    this.name = 'ChangeInProgressError'
  }
}

let pool: Pool | null = null
function lockPool(): Pool {
  // Created on first use, so DATABASE_URL is read when a change runs rather
  // than whenever this module happens to be imported.
  if (!pool) pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 8 })
  return pool
}

interface Held {
  projectId: string
  client: PoolClient
}
const held = new AsyncLocalStorage<Held>()

/**
 * Run `fn` holding the project's change lock, with the connection that holds it.
 * Statements run on that connection are inside the lock by construction.
 */
export async function withChangeLock<T>(
  projectId: string,
  fn: (client: PoolClient) => Promise<T>,
  opts: { waitMs?: number } = {},
): Promise<T> {
  const current = held.getStore()
  if (current && current.projectId === projectId) return fn(current.client)

  const client = await lockPool().connect()
  const key = projectToLockKey(projectId)
  let locked = false
  let broken = false
  try {
    const waitMs = Math.max(1, Math.floor(opts.waitMs ?? DEFAULT_WAIT_MS))
    await client.query(`SET lock_timeout = ${waitMs}`)
    try {
      await client.query('SELECT pg_advisory_lock($1::int4, $2::int4)', [CHANGE_LOCK_NAMESPACE, key])
      locked = true
    } catch (err: any) {
      // 55P03 lock_not_available: lock_timeout expired while waiting.
      if (err?.code === '55P03') throw new ChangeInProgressError()
      throw err
    } finally {
      await client.query('RESET lock_timeout').catch(() => { broken = true })
    }
    return await held.run({ projectId, client }, () => fn(client))
  } finally {
    if (locked) {
      const res = await client
        .query<{ released: boolean }>('SELECT pg_advisory_unlock($1::int4, $2::int4) AS released', [CHANGE_LOCK_NAMESPACE, key])
        .catch(() => null)
      if (res?.rows[0]?.released !== true) {
        // Destroy the connection rather than return it to the pool still
        // holding the lock: a session-scoped lock is released when its
        // session ends, and nothing else would end it.
        broken = true
        console.error(`[ChangeLock] could not release the change lock for ${projectId}; discarding the connection`)
      }
    }
    client.release(broken)
  }
}

/** Close the pool. Tests only. */
export async function closeChangeLockPool(): Promise<void> {
  const p = pool
  pool = null
  await p?.end().catch(() => {})
}

/**
 * Read the catalog on `client` with search_path pinned to pg_catalog, inside a
 * read-only transaction, so every definition comes back schema-qualified.
 * Must not be called while `client` has a transaction open.
 */
export async function readCatalogOn(client: PoolClient, schema: string): Promise<CatalogSnapshot> {
  await client.query('BEGIN READ ONLY')
  try {
    await client.query('SET LOCAL search_path TO pg_catalog')
    const snapshot = await readCatalog(
      { query: async (sql, params) => (await client.query(sql, params as unknown[])).rows },
      schema,
    )
    await client.query('COMMIT')
    return snapshot
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  }
}
