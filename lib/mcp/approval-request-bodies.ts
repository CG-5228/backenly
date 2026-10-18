/**
 * AN APPROVAL REQUEST'S WORDS AND EXACT CALL, KEPT WHERE ITS PROJECT IS
 * =====================================================================
 * A call an agent parks for a human (lib/mcp/approvals.ts) is an
 * agent_approval_requests row, a platform row in the home region. It records
 * the agent's request in its own words, a description of the call's target,
 * which can name an end user's email, a file's path or a value the call was
 * given, and the call's exact arguments, which approval runs verbatim. For a
 * project kept in another region all three stay there: in the region's
 * public.regional_bodies (lib/data-plane/regional-bodies.ts, kind
 * approval_request), under the request's id. The row keeps what the platform
 * needs to list, poll, expire and decide the request: the tool, a message that
 * names only the tool, the tool and a keyed stand-in for the target, the
 * arguments' shape (lib/data-plane/residency.ts) and `keptInRegion`.
 *
 * A home project's rows keep all three, as they always have.
 *
 * Every writer and reader of a request's words and call goes through here. The
 * surfaces that show a request read them from the region and, when the region
 * cannot be read, show the row as the platform has it. Approval does not fall
 * back: it runs exactly the call the request was made with, so a region it
 * cannot read, or one without the call, runs nothing.
 *
 * The region keeps them for REGIONAL_BODY_RETENTION_DAYS. A request can be
 * approved only until it expires, a day after it was made (APPROVAL_TTL_MS), so
 * approval never needs them after that; an older request is shown with its
 * stand-ins.
 */

import { createHmac } from 'crypto'
import { regionalBodiesFor, type RegionalBodies } from '@/lib/data-plane/regional-bodies'
import { argumentShape } from '@/lib/data-plane/residency'

/** What a request records: what the approver reads, and the call approval runs. */
export interface ApprovalRequestBody {
  message: string
  target: string
  toolArgs: Record<string, unknown>
}

/**
 * Whether a row's call is kept in its project's region: the row then has the
 * call's shape and `keptInRegion` in its place, which must never be run.
 */
export function callKeptInRegion(toolArgs: unknown): boolean {
  return (
    !!toolArgs &&
    typeof toolArgs === 'object' &&
    !Array.isArray(toolArgs) &&
    (toolArgs as Record<string, unknown>).keptInRegion === true
  )
}

/** The stand-in a regional project's row keeps for a request's target. */
export function approvalTargetStandIn(projectId: string, target: string): string {
  const key = process.env.ENV_VAR_ENCRYPTION_KEY || process.env.JWT_SECRET
  if (!key) throw new Error('No key for approval request stand-ins: set ENV_VAR_ENCRYPTION_KEY or JWT_SECRET.')
  const digest = createHmac('sha256', key).update(`backenly:approval-request-target:v1:${projectId}:${target}`).digest('base64url')
  return `t_${digest.slice(0, 32)}`
}

/** What a regional project's row says in place of the agent's request: the tool, and nothing the agent wrote. */
function messageKeptInRegion(tool: string): string {
  return `An agent asked to run ${tool}. Its request and exact call are kept in the project’s region.`
}

/**
 * A request that could not be kept in its project's region. No row was
 * written, so nothing is waiting for approval and nothing ran.
 */
export class ApprovalRequestNotKept extends Error {
  constructor() {
    super('This request could not be kept in the project’s region, so it was not queued for approval and nothing was run. Try again.')
    this.name = 'ApprovalRequestNotKept'
  }
}

function why(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * What a request's row stores, after keeping the request in the project's
 * region when the project is kept there. Called BEFORE the row is written,
 * with the id the row then takes, so a row never exists without its record.
 * Throws ApprovalRequestNotKept when the region cannot be read or written, and
 * the caller then writes no row.
 */
export async function keepApprovalRequest(
  projectId: string,
  requestId: string,
  tool: string,
  request: ApprovalRequestBody,
): Promise<ApprovalRequestBody> {
  let bodies: RegionalBodies
  try {
    bodies = await regionalBodiesFor(projectId)
  } catch (err) {
    console.warn(`[approvals] the region of ${projectId} could not be read to keep a request: ${why(err)}`)
    throw new ApprovalRequestNotKept()
  }
  // A home project after all: an earlier lookup of its region failed and this
  // one did not. Its row keeps the request, as every home project's does.
  if (!bodies.region) return request

  const stored: ApprovalRequestBody = {
    message: messageKeptInRegion(tool),
    target: `${tool} target ${approvalTargetStandIn(projectId, request.target)}`,
    toolArgs: { keptInRegion: true, shape: argumentShape(request.toolArgs) },
  }
  try {
    await bodies.set('approval_request', requestId, { payload: request })
  } catch (err) {
    console.warn(`[approvals] a request of ${projectId} could not be kept in its region: ${why(err)}`)
    throw new ApprovalRequestNotKept()
  }
  return stored
}

/** A request's record as the region keeps it, or null when what is there is not one. */
function bodyOf(payload: unknown): ApprovalRequestBody | null {
  if (!payload || typeof payload !== 'object') return null
  const { message, target, toolArgs } = payload as Partial<ApprovalRequestBody>
  if (typeof message !== 'string' || typeof target !== 'string') return null
  if (!toolArgs || typeof toolArgs !== 'object' || Array.isArray(toolArgs)) return null
  return { message, target, toolArgs }
}

/** A regional row with what its region keeps: the row a home project's would be. */
function withBody<T extends object>(row: T, body: ApprovalRequestBody): T {
  return {
    ...row,
    ...('message' in row ? { message: body.message } : {}),
    ...('target' in row ? { target: body.target } : {}),
    ...('toolArgs' in row ? { toolArgs: body.toolArgs } : {}),
  }
}

/**
 * Requests with their words, targets and calls read back from the region for
 * a regional project, for the surfaces that show them. A region that cannot be
 * read, or that no longer has a request's record, leaves the row as the
 * platform has it: the tool, a message naming it, the target's stand-in and the
 * call's shape. Never throws.
 */
export async function withApprovalRequests<T extends { id: string; toolArgs: unknown }>(
  projectId: string,
  rows: T[],
): Promise<T[]> {
  const kept = rows.filter((row) => callKeptInRegion(row.toolArgs))
  if (kept.length === 0) return rows
  try {
    const bodies = await regionalBodiesFor(projectId)
    const found = bodies.region ? await bodies.getMany('approval_request', kept.map((row) => row.id)) : new Map()
    return rows.map((row) => {
      const body = callKeptInRegion(row.toolArgs) ? bodyOf(found.get(row.id)?.payload) : null
      return body ? withBody(row, body) : row
    })
  } catch (err) {
    console.warn(`[approvals] the requests of ${projectId} could not be read in its region: ${why(err)}`)
    return rows
  }
}

/** Why a call kept in a project's region cannot be run. */
export type CallUnreadable = 'unreachable' | 'missing'

/**
 * The exact call a regional project's request was made with, read from its
 * region for the approval that runs it; or why it cannot be: the region could
 * not be reached, or it has no record of the request that names a call. There
 * is no fallback to the row, whose shape of the call is not the call.
 */
export async function keptCallForReplay(
  projectId: string,
  requestId: string,
): Promise<{ toolArgs: Record<string, unknown> } | { unreadable: CallUnreadable }> {
  let payload: unknown = null
  try {
    const bodies = await regionalBodiesFor(projectId)
    if (bodies.region) payload = (await bodies.get('approval_request', requestId))?.payload
  } catch (err) {
    console.warn(`[approvals] request ${requestId} of ${projectId} could not be read in its region: ${why(err)}`)
    return { unreadable: 'unreachable' }
  }
  const body = bodyOf(payload)
  return body ? { toolArgs: body.toolArgs } : { unreadable: 'missing' }
}
