/**
 * A fix outcome claims only what was measured.
 *
 * `evaluateFixOutcome` compares a before-state with the after-state to catch a
 * fix that closed its own gap but broke something else. Both fix paths take
 * that before-state with `captureCheckBaseline(...).catch(() => null)`, and a
 * null before-state skipped the comparison while the verdict still read
 * "confirmed closed, with no regressions". Nothing had looked.
 *
 * `judgeFixOutcome` is the verdict half, pure, so each rule is pinned here
 * without a database. The copy half pins that what a fix event says it did is
 * structural (what changed), never a performance effect nobody measured.
 */

import {
  INVARIANTS,
  judgeFixOutcome,
  owningInvariantIds,
} from '@/lib/autonomy/desired-state'
import { explainAutonomyEvent } from '@/lib/autonomy/because-copy'
import type { CheckState } from '@/lib/autonomy/fix-acceptance'

const GAP = { tableName: 'orders', columnName: 'user_id' }
const OWNING_IDS = owningInvariantIds('missing_fk_index', GAP)
const OWNING = OWNING_IDS[0]
// Any other invariant the fix could be held responsible for breaking.
const OTHER = INVARIANTS.map((i) => i.id).find(
  (id) => !OWNING_IDS.includes(id) && id !== 'data_plane_is_answering',
)!

const gapRow = {
  invariantId: OWNING,
  type: 'missing_fk_index',
  severity: 'warning',
  tier: 0,
  details: GAP,
}

/** An after-state in the shape computeDesiredStateDiff returns. */
function after(opts: { gapStillThere?: boolean; owningCouldNotRun?: boolean; otherHolds: boolean }) {
  const owningGaps = opts.gapStillThere ? [gapRow] : []
  return {
    invariants: [
      {
        id: OWNING,
        title: 'Foreign keys indexed',
        // A probe that could not run is reported unsatisfied with no gaps.
        satisfied: !opts.gapStillThere && !opts.owningCouldNotRun,
        gaps: owningGaps,
      },
      { id: OTHER, title: 'Other guarantee', satisfied: opts.otherHolds, gaps: [] },
    ],
    violations: owningGaps,
  } as any
}

const before: CheckState[] = [
  { id: OWNING, passing: false },
  { id: OTHER, passing: true },
]

describe('judgeFixOutcome: the regression half says whether it ran', () => {
  it('never claims "no regressions" when there was no before-state', () => {
    const o = judgeFixOutcome('missing_fk_index', GAP, after({ otherHolds: true }), null)
    expect(o.recheck).toBe('resolved')
    expect(o.accepted).toBe(true)
    expect(o.regressionCheck).toBe('unavailable')
    expect(o.reason).not.toMatch(/no regressions/i)
    expect(o.reason).toMatch(/were not compared/)
  })

  it('claims "no regressions" only after comparing', () => {
    const o = judgeFixOutcome('missing_fk_index', GAP, after({ otherHolds: true }), before)
    expect(o.regressionCheck).toBe('ran')
    expect(o.accepted).toBe(true)
    expect(o.reason).toMatch(/with no regressions/)
  })

  it('rejects a fix that broke a guarantee that held before it', () => {
    const o = judgeFixOutcome('missing_fk_index', GAP, after({ otherHolds: false }), before)
    expect(o.regressionCheck).toBe('ran')
    expect(o.regressions).toEqual([OTHER])
    expect(o.accepted).toBe(false)
  })

  it('cannot attribute a failure to the fix without a before-state, and says it did not look', () => {
    const o = judgeFixOutcome('missing_fk_index', GAP, after({ otherHolds: false }), null)
    expect(o.regressions).toEqual([])
    expect(o.regressionCheck).toBe('unavailable')
    expect(o.reason).not.toMatch(/no regressions/i)
  })
})

describe('judgeFixOutcome: the target half', () => {
  it('reports a gap still present as unresolved', () => {
    const o = judgeFixOutcome('missing_fk_index', GAP, after({ gapStillThere: true, otherHolds: true }), before)
    expect(o.recheck).toBe('unresolved')
    expect(o.accepted).toBe(false)
  })

  it('says the confirming check could not run, rather than that no probe covers the type', () => {
    const o = judgeFixOutcome('missing_fk_index', GAP, after({ owningCouldNotRun: true, otherHolds: true }), before)
    expect(o.recheck).toBe('unknown')
    expect(o.accepted).toBe(false)
    expect(o.reason).toMatch(/could not run/)
    expect(o.reason).not.toMatch(/No probe covers/)
  })

  it('says when no probe covers the type at all', () => {
    const o = judgeFixOutcome('missing_api_crud', { tableName: 'orders' }, after({ otherHolds: true }), before)
    expect(o.recheck).toBe('unknown')
    expect(o.accepted).toBe(false)
    expect(o.reason).toMatch(/No probe covers this type/)
  })
})

describe('fix copy is structural', () => {
  // Every kind the copy module has a branch for. What a fix event says it DID
  // must name the change, never an effect on speed or cost that nothing
  // measured; the conditional "why" may explain the risk it addresses.
  const KINDS = [
    'missing_fk_index', 'missing_index', 'query_pattern_missing_index', 'missing_fk_constraint',
    'missing_foreign_key', 'missing_rls', 'unprotected_user_data', 'weak_rls', 'rls_denies_everything',
    'over_permissive_rls', 'missing_api_definition', 'missing_api_crud', 'api_drift', 'arch_migration',
    'shadow_mutation', 'unbounded_pagination', 'missing_rate_limit', 'rate_limit_gap',
    'webhook_replay_risk', 'missing_archival_job', 'stale_data_overflow', 'missing_token_cleanup_cron',
    'expired_token_buildup', 'auth_integrity_gap', 'missing_users_table', 'missing_jwt_secret',
    'missing_retry_queue',
  ]
  const MEASURED_EFFECT = /\b(faster|sped up|speeds? up|improved|reduced|cut|lowered|latency|quicker|\d+(\.\d+)?\s*(ms|%|x)\b)/i

  it.each(KINDS)('%s says what changed, not a performance effect', (kind) => {
    const e = explainAutonomyEvent({ findingType: kind, tableName: 'orders', columnName: 'user_id' })
    expect(e.what).not.toMatch(MEASURED_EFFECT)
  })
})
