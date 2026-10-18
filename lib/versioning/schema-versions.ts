/**
 * SCHEMA VERSIONING SYSTEM
 * =========================
 * Snapshots the workspace schema before every mutation.
 * Enables rollback to any previous state.
 *
 * Every CREATE_TABLE, ADD_COLUMN, and ALTER TABLE call should
 * trigger a snapshot beforehand so the user can undo changes.
 *
 * Snapshot format: JSON representation of the live schema
 *   { tables: [{ name, columns: [{ name, type, nullable, unique }] }] }
 */

import { prisma } from '@/lib/db/prisma'

export interface ColumnSnapshot {
  name: string
  type: string
  nullable: boolean
  unique: boolean
  default?: string
}

export interface TableSnapshot {
  name: string
  columns: ColumnSnapshot[]
  foreignKeys: Array<{ column: string; referencesTable: string; referencesColumn: string }>
}

export interface SchemaSnapshot {
  tables: TableSnapshot[]
  capturedAt: string
}

export interface SchemaVersionRecord {
  id: string
  versionNum: number
  description: string
  triggeredBy: string
  createdAt: Date
  snapshot: SchemaSnapshot
}

/**
 * Capture the current live schema of a workspace and save it as a new version.
 * Returns the version ID.
 */
export async function snapshotSchema(
  projectId: string,
  description: string,
  triggeredBy: string
): Promise<string> {
  // Get current schema via introspection
  const { introspectSchema } = await import('@/lib/ai/minimal-executor')
  const schemaText = await introspectSchema(projectId)

  // Parse the schema text into a structured snapshot
  const snapshot: SchemaSnapshot = {
    tables: parseSchemaText(schemaText),
    capturedAt: new Date().toISOString(),
  }

  // Get next version number
  const lastVersion = await prisma.schemaVersion.findFirst({
    where: { projectId },
    orderBy: { versionNum: 'desc' },
    select: { versionNum: true },
  })
  const versionNum = (lastVersion?.versionNum ?? 0) + 1

  const record = await prisma.schemaVersion.create({
    data: {
      projectId,
      versionNum,
      snapshot: snapshot as any,
      description,
      triggeredBy,
    },
  })

  return record.id
}

/**
 * List all schema versions for a project (newest first).
 */
export async function listSchemaVersions(projectId: string): Promise<Array<{
  id: string
  versionNum: number
  description: string
  triggeredBy: string
  createdAt: Date
}>> {
  return prisma.schemaVersion.findMany({
    where: { projectId },
    orderBy: { versionNum: 'desc' },
    take: 50,
    select: { id: true, versionNum: true, description: true, triggeredBy: true, createdAt: true },
  })
}

/**
 * Get a specific schema version snapshot, scoped to the project that owns it.
 *
 * `projectId` is REQUIRED, and the lookup filters on it rather than checking
 * afterwards, because this used to be a `findUnique` on the version id alone.
 * A version id is a uuid from a different namespace than a project id, so
 * holding one said nothing about which project it belonged to — and the only
 * caller that could have compared them never saw `projectId`, since this
 * function strips it from what it returns.
 *
 * The result was that `rollbackToVersion` would happily roll a project back to
 * ANOTHER project's snapshot: destroying the caller's schema using a shape it
 * had never had, and disclosing the other tenant's table structure on the way.
 *
 * Scoping the query makes that unrepresentable instead of relying on every
 * caller to remember a check.
 */
export async function getSchemaVersion(
  versionId: string,
  projectId: string,
): Promise<SchemaVersionRecord | null> {
  const record = await prisma.schemaVersion.findFirst({
    where: { id: versionId, projectId },
  })
  if (!record) return null
  return {
    id: record.id,
    versionNum: record.versionNum,
    description: record.description,
    triggeredBy: record.triggeredBy,
    createdAt: record.createdAt,
    snapshot: record.snapshot as unknown as SchemaSnapshot,
  }
}

/**
 * Retired: rolling back is per change, through the change ledger.
 *
 * This used to diff the live schema against a SchemaVersion and run
 * `DROP TABLE … CASCADE` on every table newer than it. Those snapshots never
 * recorded columns, so it could not restore a column, a constraint or a policy;
 * it could only destroy tables and their rows, non-transactionally, under the
 * name "rollback".
 *
 * Restoring now goes through lib/changes/recovery.ts: one change at a time,
 * proven first, in one transaction, keeping what it removes in a vault, and
 * verified against the restore point afterwards. It runs automatically only
 * when that is lossless and the change failed its checks; otherwise a person
 * decides, from Database → Changes or by approving a request. This function
 * stays exported so nothing that still imports it can reach the old behaviour;
 * it changes nothing and says where restoring lives.
 */
export async function rollbackToVersion(
  projectId: string,
  targetVersionId: string,
): Promise<{ success: boolean; statementsExecuted: string[]; message: string }> {
  // Still scoped: another project's version is not found, never described.
  const target = await getSchemaVersion(targetVersionId, projectId)
  if (!target) {
    return { success: false, statementsExecuted: [], message: 'Version not found.' }
  }
  return {
    success: false,
    statementsExecuted: [],
    message:
      `Schema v${target.versionNum} cannot be restored wholesale. Each schema change since then is recorded with a ` +
      'restore point, and the state before any one of them can be restored from Database → Changes, checked ' +
      'first and verified afterwards. Nothing was changed.',
  }
}

// ─── Internal: parse schema text into structured snapshot ─────────────────────

function parseSchemaText(schemaText: string): TableSnapshot[] {
  const tables: TableSnapshot[] = []
  if (!schemaText) return tables

  // Basic parser: look for "Table: name\n  column: type" pattern
  // (introspectSchema returns a formatted string)
  const tableBlocks = schemaText.split(/\n(?=Table:|table:)/i)

  for (const block of tableBlocks) {
    const nameMatch = block.match(/[Tt]able:\s*(\w+)/)
    if (!nameMatch) continue

    const columns: ColumnSnapshot[] = []
    const fkLines = block.match(/FK:\s*(\w+)\s*→\s*(\w+)\((\w+)\)/g) ?? []

    const foreignKeys = fkLines.map(fk => {
      const m = fk.match(/FK:\s*(\w+)\s*→\s*(\w+)\((\w+)\)/)
      return m ? { column: m[1], referencesTable: m[2], referencesColumn: m[3] } : null
    }).filter(Boolean) as TableSnapshot['foreignKeys']

    tables.push({ name: nameMatch[1], columns, foreignKeys })
  }

  return tables
}
