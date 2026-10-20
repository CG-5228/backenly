/**
 * The async context the change ledger keeps: the governed change open for a
 * project (lib/changes/ledger.ts) and who is acting (./attribution.ts).
 *
 * Node carries an async context into every timer and promise started inside
 * it, so work that outlives the request that scheduled it (the repair loop's
 * kick, a post-build pass, the observer) used to run inside a change that had
 * already closed, joined it as if it were part of it, and was recorded nowhere,
 * attributed to whoever made that change.
 *
 * Its own module, depending only on attribution, so whatever schedules work
 * for later can step outside both without importing the ledger.
 */

import { AsyncLocalStorage } from 'async_hooks'
import type { PoolClient } from 'pg'
import { outsideSqlCapture } from '@/lib/execution/sql-recorder'
import { outsideAttribution } from './attribution'

/** What the ledger keeps open: whose change it is, and whether its work is over. */
export interface ChangeContext {
  projectId: string
  /** Set once the change's own work has returned; nothing joins it after that. */
  finished: boolean
}

/** The governed change open in the current async context. Only the ledger runs it. */
export const openChangeContext = new AsyncLocalStorage<ChangeContext>()

/** The project change lock this async context holds (./lock.ts), and whether it has been given back. */
export interface HeldChangeLock {
  projectId: string
  client: PoolClient
  /** Set when the lock is released; a released lock is never re-entered. */
  released: boolean
}

/**
 * The change lock held in the current async context. Here rather than in
 * ./lock.ts so that leaving it needs no database module: work that outlived
 * its change inherited it too, and re-entered a lock that was no longer held,
 * on a connection already returned to the pool.
 */
export const heldChangeLock = new AsyncLocalStorage<HeldChangeLock>()

/**
 * Run `fn` with no governed change open, no change lock held, no statements
 * being captured and no one attributed: for work that is its own actor,
 * whatever request scheduled it. The changes it makes are its own, and
 * Backenly's: it takes the change lock itself, waiting for any change still
 * applying, and its statements are recorded on its own change.
 */
export function outsideAnyChange<T>(fn: () => T): T {
  return openChangeContext.exit(() => heldChangeLock.exit(() => outsideSqlCapture(() => outsideAttribution(fn))))
}
