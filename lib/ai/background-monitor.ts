/**
 * BACKGROUND MONITOR — the scheduled entry into the autonomy loop
 * ================================================================
 * Called by:
 *   - app/api/cron/background-health/route.ts
 *   - instrumentation.ts (daily sweep)
 *   - the post-build orchestrator, after a build lands
 *
 * It runs the canonical loop: desired-state invariants, then the reconciler,
 * then the auto-fix kernel, whose every repair is re-checked against the live
 * database before anything calls it fixed.
 *
 * It used to run a second pipeline first, the agent orchestrator (since
 * deleted with its agents). That pipeline filed its own findings, applied
 * fixes through its own connection pool without a re-check, and announced
 * "Auto-fixed N backend issue(s)". Every real problem it found is found by the
 * canonical detectors, and its other findings were not real problems
 * (docs/autonomy-orchestrator-parity.md). It no longer runs. What it filed is
 * withdrawn here, except findings someone already acted on.
 *
 * The cadence floor and monthly scan budget that gated this function bounded
 * the orchestrator's model calls. Nothing here calls a model now, and the
 * reconciler runs every minute on its own, so there is nothing left to bound.
 *
 * Never throws. One project failure never blocks others.
 */

import { runReconciler } from '@/lib/autonomy/reconciler'
import { retireOrchestratorFindings } from '@/lib/core/finding-reaper'

export async function runMonitoredHealthScan(
  projectId: string,
  // Kept for the callers' signature; the canonical loop resolves its own principals.
  _userId: string,
): Promise<void> {
  try {
    await retireOrchestratorFindings(projectId).catch((err: any) => {
      console.warn(`[BackgroundMonitor] Retiring orchestrator findings failed for ${projectId}:`, err?.message)
    })
    // Master switch FLAGS.ENABLE_AUTONOMY_RECONCILER is checked inside. Per
    // project: dial OFF means shadow (observe and record); any other level means
    // live execution, bounded by tier, circuit breaker and change-freeze.
    await runReconciler(projectId)
  } catch (err: any) {
    console.warn(`[BackgroundMonitor] Scan failed for ${projectId}:`, err?.message)
  }
}
