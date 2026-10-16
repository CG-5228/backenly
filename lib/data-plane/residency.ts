/**
 * WHAT A PLATFORM ROW MAY QUOTE ABOUT A PROJECT'S WORK
 * ====================================================
 * The platform database is in the home region. A project kept in another
 * region keeps its customer data there (founders, 2026-10-16: residency is
 * fixed before any region opens), so the platform's records of its work keep
 * the names, kinds, counts and ids of what was done, never the text the work
 * carried:
 *   - the request, which can name an end user ("block alice@example.com");
 *   - the agent's reply and a tool's result summary, which can quote rows;
 *   - a tool's arguments, which can be the rows themselves (insert_data);
 *   - an error message, which PostgreSQL fills with the offending values
 *     ("Key (email)=(alice@example.com) already exists").
 *
 * A home project's records are unchanged: its data is in this database
 * already. This module only decides; each writer applies it to its own row.
 */

import { HOME_REGION } from '@/lib/regions'
import { projectRegion } from '@/lib/data-plane/regional'

/**
 * Whether platform rows may quote a project's requests, replies, arguments,
 * results and errors: for a project kept in the home region only. A project
 * whose region cannot be read is quoted nowhere, so a lookup failure never
 * writes what residency keeps out.
 */
export async function quotesKeptHere(projectId: string): Promise<boolean> {
  try {
    return (await projectRegion(projectId)) === HOME_REGION
  } catch {
    return false
  }
}

/**
 * What a platform row says in place of a message it may not quote: there was
 * one, and it was not recorded. It is not kept anywhere else either.
 */
export const NOT_QUOTED = 'Not recorded: this project’s data stays in its own region.'

/** Argument names whose values are a project's structure, not its data. */
const STRUCTURE_KEYS = new Set([
  'table',
  'tableName',
  'targetTable',
  'column',
  'columnName',
  'bucket',
  'bucketName',
  'functionName',
  'triggerName',
])

/** A SQL identifier: what a table, column, bucket or function is named. */
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_-]{0,62}$/

/** An opaque id (uuid, cuid): letters, digits, `-` and `_` only, so never an email. */
const OPAQUE_ID = /^[A-Za-z0-9_-]{8,64}$/

/**
 * A tool's arguments as a platform row may keep them for a project kept in
 * another region: every argument's name; the value of a structural name (a
 * table, a column, a bucket, a function) when it is an identifier, of an id
 * when it is opaque, and of a number or a flag; for a list, its length;
 * anything else only as its kind. So `insert_data` keeps the table and how
 * many rows, never the rows.
 */
export function argumentShape(args: Record<string, unknown> | null | undefined): Record<string, unknown> {
  const shape: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(args ?? {})) {
    if (Array.isArray(value)) shape[key] = { count: value.length }
    else if (typeof value === 'string' && STRUCTURE_KEYS.has(key) && IDENTIFIER.test(value)) shape[key] = value
    else if (typeof value === 'string' && /(?:^id|Id)$/.test(key) && OPAQUE_ID.test(value)) shape[key] = value
    else if (typeof value === 'number' || typeof value === 'boolean' || value === null) shape[key] = value
    else shape[key] = `[${typeof value}]`
  }
  return shape
}
