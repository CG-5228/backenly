/**
 * WHERE A DELIVERY'S BODY IS KEPT
 * ===============================
 * A webhook or trigger delivery carries the row that fired it, and records
 * what the receiver answered: both are customer data. For a project in the
 * home region they stay on the delivery's row in the platform database, as
 * they always have. For a project in another region they never leave that
 * region (founders, 2026-10-16: a region opens only once its customers' data
 * stays in it). The platform row then keeps only what the platform needs to
 * schedule, list, retry and alert: ids, event, status, HTTP status, attempts
 * and times. The body is kept in the region's own database, in
 * public.delivery_bodies (scripts/sql/delivery-bodies.sql, installed by the
 * region's database procedure), for DELIVERY_BODY_RETENTION_DAYS at most.
 *
 * The body is written BEFORE the platform row, under the id the row then
 * takes, so a row never exists without its body. A body whose row was never
 * written is pruned with the rest.
 *
 * A region whose database cannot be reached is an error, never a fallback: a
 * body is not written to the home database instead, and a retry that cannot
 * read its body waits for a later tick.
 */

import { regionRawClient, projectRegion } from '@/lib/data-plane/regional'
import { HOME_REGION, type CloudRegionId } from '@/lib/regions'

export type DeliveryKind = 'webhook' | 'trigger'

/** How long a region keeps a delivery's body. */
export const DELIVERY_BODY_RETENTION_DAYS = 30

export interface HeldBody {
  payload: unknown
  responseBody: string | null
  error: string | null
}

export interface DeliveryBodies {
  /** The region the bodies are held in, or null when they stay on the platform row. */
  readonly region: CloudRegionId | null
  /** Keep a new delivery's payload, under the id its platform row will take. */
  put(kind: DeliveryKind, id: string, payload: unknown): Promise<void>
  /** Record what the latest attempt was answered with; a field left undefined is kept. */
  answer(id: string, answer: { responseBody?: string | null; error?: string | null }): Promise<void>
  get(id: string): Promise<HeldBody | null>
  getMany(ids: string[]): Promise<Map<string, HeldBody>>
}

/** A home project's bodies: on the platform row, so nothing is kept elsewhere. */
export const BODIES_ON_THE_ROW: DeliveryBodies = {
  region: null,
  put: async () => {},
  answer: async () => {},
  get: async () => null,
  getMany: async () => new Map(),
}

/** Where a project's delivery bodies are kept. */
export async function deliveryBodiesFor(projectId: string): Promise<DeliveryBodies> {
  const region = await projectRegion(projectId)
  return region === HOME_REGION ? BODIES_ON_THE_ROW : regionalBodies(region, projectId)
}

interface BodyRow {
  id: string
  payload: unknown
  responseBody: string | null
  error: string | null
}

function regionalBodies(region: CloudRegionId, projectId: string): DeliveryBodies {
  // Resolved on every call, so a region whose connection goes away is refused
  // rather than served from a client made earlier (lib/data-plane/regional.ts).
  const db = () => regionRawClient(region, projectId)

  return {
    region,

    async put(kind, id, payload) {
      await db().$executeRaw`
        INSERT INTO public.delivery_bodies ("id", "kind", "projectId", "payload")
        VALUES (${id}, ${kind}, ${projectId}, ${JSON.stringify(payload ?? null)}::jsonb)`
    },

    async answer(id, answer) {
      if (answer.responseBody !== undefined) {
        await db().$executeRaw`
          UPDATE public.delivery_bodies SET "responseBody" = ${answer.responseBody}, "updatedAt" = now()
          WHERE "id" = ${id} AND "projectId" = ${projectId}`
      }
      if (answer.error !== undefined) {
        await db().$executeRaw`
          UPDATE public.delivery_bodies SET "error" = ${answer.error}, "updatedAt" = now()
          WHERE "id" = ${id} AND "projectId" = ${projectId}`
      }
    },

    async get(id) {
      const rows = await db().$queryRaw<BodyRow[]>`
        SELECT "id", "payload", "responseBody", "error" FROM public.delivery_bodies
        WHERE "id" = ${id} AND "projectId" = ${projectId}`
      const row = rows[0]
      return row ? { payload: row.payload, responseBody: row.responseBody, error: row.error } : null
    },

    async getMany(ids) {
      if (ids.length === 0) return new Map()
      const rows = await db().$queryRaw<BodyRow[]>`
        SELECT "id", "payload", "responseBody", "error" FROM public.delivery_bodies
        WHERE "projectId" = ${projectId} AND "id" = ANY(${ids}::text[])`
      return new Map(rows.map((r) => [r.id, { payload: r.payload, responseBody: r.responseBody, error: r.error }]))
    },
  }
}

/**
 * Delete the region's bodies past their retention. Run by the region's own
 * scheduler (lib/services/cron-runner.ts). The home region keeps its bodies on
 * the platform rows, under that table's own retention, so there is nothing to
 * prune here for it.
 */
export async function pruneDeliveryBodies(region: CloudRegionId, now: Date = new Date()): Promise<number> {
  if (region === HOME_REGION) return 0
  const cutoff = new Date(now.getTime() - DELIVERY_BODY_RETENTION_DAYS * 24 * 60 * 60 * 1000)
  return regionRawClient(region).$executeRaw`DELETE FROM public.delivery_bodies WHERE "createdAt" < ${cutoff}`
}

/**
 * What a regional trigger delivery's platform row may say about a failure:
 * its HTTP status, never the receiver's words, which can quote the row it was
 * sent. The full text is kept with the body, in the region.
 */
export function failureWithoutReply(error: string | undefined, statusCode: number | undefined): string | null {
  if (error === undefined) return null
  if (statusCode !== undefined) return `Webhook returned ${statusCode}`
  const reply = /^Webhook returned (\d{3}):/.exec(error)
  return reply ? `Webhook returned ${reply[1]}` : error
}
