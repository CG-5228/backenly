/**
 * POST-BUILD ORCHESTRATOR
 * =======================
 * Runs automatically after every successful build. No manual trigger needed.
 *
 * Pipeline (all fire-and-forget, never blocks the build response):
 *
 *   Build complete
 *     → Schema reconciliation    — compare desired vs actual, auto-fix safe drift
 *     → Multi-agent health scan  — security, performance, migration, repair agents
 *       → Auto-fix safe issues   — immediate execution
 *       → Queue dangerous issues — stored as HealthFindings for user approval
 *       → Notify user            — "while you were away" banner
 *
 * This is the "backend runs itself" layer. The reconciler is the Kubernetes-style
 * controller: desired state = BackendGraph/ProductBlueprint, actual state = live DB.
 *
 * Rules:
 *   - Never throws — one failure must not prevent others
 *   - Never blocks the build SSE response — always fire-and-forget
 *   - Only auto-fixes SAFE operations (add index, enable RLS, add missing column)
 *   - NEVER auto-drops tables or removes data — always queues for approval
 */

import type { BuildResponse } from './types'

// ── Drift severity tiers ───────────────────────────────────────────────────────

/** Safe to auto-fix immediately — additive, never destructive. */
const AUTO_FIX_DRIFT_TYPES = new Set([
  'missing_index',
  'missing_rls',
  'missing_column',  // additive — new nullable column
])

// The dangerous tier (missing_table, type_mismatch, extra_table, extra_column)
// is intentionally NOT applied or persisted here — see the comment in
// _runReconciliation below for why the finding used to be recorded in this
// function and no longer is.

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Trigger the full post-build orchestration pipeline asynchronously.
 *
 * Call this immediately after renderBuildResponse — returns void instantly,
 * the actual work runs in the background without blocking the SSE stream.
 */
export function triggerPostBuildOrchestration(
  projectId: string,
  userId: string,
  buildResponse: BuildResponse,
): void {
  // Intentionally NOT awaited — fire-and-forget
  _runOrchestration(projectId, userId, buildResponse).catch((err) => {
    console.error(`[PostBuildOrchestrator] Unhandled error for project ${projectId}:`, err?.message)
  })
}

// ── Internal pipeline ─────────────────────────────────────────────────────────

async function _runOrchestration(
  projectId: string,
  userId: string,
  buildResponse: BuildResponse,
): Promise<void> {
  const builtCount = buildResponse.built?.length ?? 0

  // Only run full orchestration when something was actually built.
  // Skip for empty builds (plan-only, no-op, blocked-entirely).
  if (builtCount === 0) return

  console.log(`[PostBuildOrchestrator] Starting for project ${projectId} (${builtCount} nodes built)`)

  // Step 1: Schema reconciliation — run immediately, apply safe fixes
  await _runReconciliation(projectId).catch((err) => {
    console.warn(`[PostBuildOrchestrator] Reconciliation failed for ${projectId}:`, err?.message)
  })

  // Step 2: Multi-agent health scan — detect issues, auto-fix safe ones
  await _runHealthScan(projectId, userId).catch((err) => {
    console.warn(`[PostBuildOrchestrator] Health scan failed for ${projectId}:`, err?.message)
  })

  // Step 3 (Phase 6): Infra intelligence + architecture evolution in parallel.
  // Only runs for builds that actually created tables (builtCount > 2 guards
  // against firing on trivial one-table changes that don't shift the stage).
  if (builtCount > 2) {
    await Promise.allSettled([
      import('@/lib/ai/infra-intelligence')
        .then(({ runAndStoreInfraIntelligence }) => runAndStoreInfraIntelligence(projectId, userId))
        .catch((err: any) => console.warn(`[PostBuildOrchestrator] InfraIntel failed for ${projectId}:`, err?.message)),
      import('@/lib/ai/architecture-evolution')
        .then(({ runAndStoreArchitectureEvolution }) => runAndStoreArchitectureEvolution(projectId, userId))
        .catch((err: any) => console.warn(`[PostBuildOrchestrator] ArchEvolution failed for ${projectId}:`, err?.message)),
    ])
  }

  console.log(`[PostBuildOrchestrator] Complete for project ${projectId}`)
}

// ── Step 1: Schema reconciliation ────────────────────────────────────────────

async function _runReconciliation(projectId: string): Promise<void> {
  const { detectSchemaDrift, applyReconciliationMigrations } = await import('@/lib/ai/schema-reconciler')

  const report = await detectSchemaDrift(projectId)

  if (report.drifts.length === 0) {
    console.log(`[Reconciler] Project ${projectId}: no drift detected`)
    return
  }

  console.log(
    `[Reconciler] Project ${projectId}: ${report.drifts.length} drift items ` +
    `(critical=${report.hasCritical}, warnings=${report.hasWarnings})`
  )

  // Apply the safe tier immediately — additive, no data risk.
  const safeMigrations = report.drifts
    .filter((d) => AUTO_FIX_DRIFT_TYPES.has(d.type) && d.migration)
    .map((d) => d.migration!)

  if (safeMigrations.length > 0) {
    const result = await applyReconciliationMigrations(projectId, safeMigrations)
    console.log(
      `[Reconciler] Project ${projectId}: applied ${result.applied}/${safeMigrations.length} safe migrations` +
      (result.failed > 0 ? `, ${result.failed} failed: ${result.errors.join('; ')}` : '')
    )
  }

  // The dangerous tier (missing_table, type_mismatch, extra_table, extra_column)
  // used to be persisted here too, as a single 'schema_drift' HealthFinding type
  // shared by every drift item in the project regardless of which table or kind
  // of drift it was. That shape was broken three ways: (1) normalizeFindingType
  // aliases the bare 'schema_drift' string to 'shadow_mutation' — an AUTO_SAFE
  // type — but the finding's `details` here never carried a `tableName`, so an
  // approved "fix" resolved to FIX_API with `tableName: undefined` and could
  // not have done anything; (2) every drift item in a project collided on the
  // exact same `type` value, so Prisma's `skipDuplicates` silently dropped every
  // item after the first instead of recording each one; (3) it had no reap path,
  // so once written it could never be withdrawn even after the drift resolved.
  // Those kinds of drift are the canonical loop's to report, by cause:
  // unregistered tables (orphan_table), columns missing or retyped against what
  // was requested (intent_drift), and DDL over a direct connection
  // (external_schema_change). See docs/autonomy-orchestrator-parity.md.
}

// ── Step 2: Health scan (the canonical loop) ─────────────────────────────────

async function _runHealthScan(projectId: string, userId: string): Promise<void> {
  // No throttle. It used to skip when the agent orchestrator had written a scan
  // record in the last 30 minutes, because that scan made model calls. The
  // orchestrator is retired and nothing writes that record any more; what runs
  // now is the reconciler, which runs every minute on its own anyway.
  const { runMonitoredHealthScan } = await import('@/lib/ai/background-monitor')
  await runMonitoredHealthScan(projectId, userId)
}
