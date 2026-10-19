/**
 * Autonomy "Since Last Visit" Summary
 * ===================================
 *
 * GET /api/projects/[id]/autonomy/since-last-visit?since=ISO
 *
 * Returns the aggregated "what Backenly did while you were away" payload that
 * powers the welcome-back banner. Same source data as the events feed but
 * shaped for a one-line summary plus the few most-impactful items.
 *
 * The client owns the cursor — it stores `last_seen_at` in localStorage on
 * dismiss / focus. We just count what happened after it.
 */

import { NextRequest, NextResponse } from 'next/server'
import { withProjectValidation } from '@/lib/middleware/projectValidation'
import { prisma } from '@/lib/db/prisma'
import { AUTONOMOUS_AUDIT_ACTIONS } from '@/lib/autonomy/circuit-breaker'
import { explainAutonomyEvent } from '@/lib/autonomy/because-copy'

const MIN_SINCE_MS = 60 * 1000 // never look further forward than 1 min ago

/** Most autonomous changes read per request. */
const CHANGE_SCAN_LIMIT = 1000

export async function GET(
  request: NextRequest,
  props: { params: Promise<{ id: string }> },
) {
  const params = await props.params
  return withProjectValidation<any>(request, async (validated) => {
    const url = new URL(request.url)
    const sinceParam = url.searchParams.get('since')

    // Without a client cursor, default to the last 24h — the "you've been away
    // for a day" experience, not an empty banner.
    let since: Date
    if (sinceParam) {
      const parsed = new Date(sinceParam)
      since = isNaN(+parsed) ? new Date(Date.now() - 24 * 60 * 60 * 1000) : parsed
    } else {
      since = new Date(Date.now() - 24 * 60 * 60 * 1000)
    }

    // Clamp so a stale-tab "since=now+1m" never returns negative results.
    if (since.getTime() > Date.now() - MIN_SINCE_MS) {
      since = new Date(Date.now() - MIN_SINCE_MS)
    }

    const [changes, escalations] = await Promise.all([
      // Every autonomous change, with its details, so each can be classified by
      // the verification it recorded. Bounded; a project changing more than
      // this between visits is reported as "at least".
      prisma.auditLog.findMany({
        where: {
          projectId: validated.projectId,
          timestamp: { gt: since },
          action: { in: AUTONOMOUS_AUDIT_ACTIONS as unknown as string[] },
        },
        orderBy: { timestamp: 'desc' },
        take: CHANGE_SCAN_LIMIT,
        select: { id: true, action: true, timestamp: true, details: true },
      }),
      prisma.auditLog.count({
        where: {
          projectId: validated.projectId,
          timestamp: { gt: since },
          action: 'HEALTH_FIX_ESCALATED',
        },
      }),
    ])

    const classified = changes.map(c => {
      let d: Record<string, any> = {}
      try {
        d = c.details ? JSON.parse(c.details) : {}
      } catch { /* ignore */ }
      // Only a recorded 'confirmed' outcome is a verified fix. A change that
      // ran without one is still reported, as exactly that.
      return { row: c, details: d, verified: d.verification === 'confirmed' }
    })
    const verifiedFixes = classified.filter(c => c.verified).length
    const unverifiedChanges = classified.length - verifiedFixes
    const atLeast = changes.length === CHANGE_SCAN_LIMIT ? 'at least ' : ''

    const examples = classified.slice(0, 5).map(({ row, details, verified }) => {
      const explained = explainAutonomyEvent(details)
      const note = verified ? '' : ' (it ran, but could not be confirmed)'
      return {
        id: row.id,
        at: row.timestamp.toISOString(),
        what: `${explained.what}${note}`,
        why: explained.why,
        full: `${explained.full}${note}`,
        kind: explained.kind,
        verified,
      }
    })

    // Autonomy performs no rollbacks today (its rollback path is not built), so
    // nothing is counted as one here. The only ROLLBACK_* audit rows are deploy
    // rollbacks someone requested, which are not something Backenly did on its
    // own while the user was away.
    const total = verifiedFixes + unverifiedChanges + escalations
    const parts: string[] = []
    if (verifiedFixes > 0) {
      parts.push(`fixed ${atLeast}${verifiedFixes} problem${verifiedFixes === 1 ? '' : 's'}, each confirmed by a re-check`)
    }
    if (unverifiedChanges > 0) {
      parts.push(`made ${atLeast}${unverifiedChanges} change${unverifiedChanges === 1 ? '' : 's'} it could not confirm`)
    }
    if (escalations > 0) parts.push(`flagged ${escalations} for your review`)

    let headline: string
    if (total === 0) {
      headline = 'Backenly didn’t need to make any changes while you were away.'
    } else if (parts.length === 1) {
      headline = `Backenly ${parts[0]} while you were away.`
    } else if (parts.length === 2) {
      headline = `Backenly ${parts[0]} and ${parts[1]} while you were away.`
    } else {
      headline = `Backenly ${parts[0]}, ${parts[1]}, and ${parts[2]} while you were away.`
    }

    return NextResponse.json({
      projectId: validated.projectId,
      since: since.toISOString(),
      now: new Date().toISOString(),
      autonomousFixes: verifiedFixes,
      unverifiedChanges,
      escalations,
      total,
      headline,
      examples,
      shouldShow: total > 0,
    })
  })
}
