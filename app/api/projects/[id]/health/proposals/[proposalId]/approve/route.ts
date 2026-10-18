export const dynamic = 'force-dynamic'

/**
 * POST /api/projects/[id]/health/proposals/[proposalId]/approve
 * Body: { proposalVersion: string }
 *
 * A person approves one exact AI-proposed repair (lib/autonomy/ai-proposals.ts).
 * Dashboard session only: withProjectAccess takes a platform session, never an
 * API or MCP key, so no agent can approve a proposal. Developer role or above.
 *
 *   200  the approval ran; `fixed` says whether all three checks confirmed it
 *   409  stale, expired, changed, already decided, or another change holds the lock
 *   404  no such proposal on this project
 */

import { NextRequest, NextResponse } from 'next/server'
import { withProjectAccess } from '@/lib/auth/route-protection'
import { canWriteProject } from '@/lib/edition/guard'
import { approveProposal } from '@/lib/autonomy/ai-proposals'

export const POST = withProjectAccess(async (req: NextRequest, { user, projectId }) => {
  if (!(await canWriteProject(user.userId, projectId))) {
    return NextResponse.json({ ok: false, error: 'Approving a repair needs developer access to this project.' }, { status: 403 })
  }
  const match = req.nextUrl.pathname.match(/\/health\/proposals\/([^/]+)\/approve/)
  const proposalId = match?.[1]
  let body: { proposalVersion?: unknown }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ ok: false, error: 'Invalid JSON body' }, { status: 400 })
  }
  if (!proposalId || typeof body.proposalVersion !== 'string' || !body.proposalVersion) {
    return NextResponse.json({ ok: false, error: 'proposalVersion is required' }, { status: 400 })
  }
  const answer = await approveProposal({ projectId, proposalId, proposalVersion: body.proposalVersion, userId: user.userId })
  return NextResponse.json(answer.body, { status: answer.status })
})
