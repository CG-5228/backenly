/**
 * AI PROMOTION REGISTRY — which AI-proposed repair classes may run without a
 * person. None.
 *
 * Every AI-proposed repair waits for a human to approve its exact version
 * (lib/autonomy/ai-proposals.ts). A class can be promoted to run on its own
 * only by a reviewed change to this file, linked to evidence of:
 *   1. repeatable real-Postgres fault tests for the class: no unsafe change,
 *      no false "verified", controls silent, observer refusals honoured;
 *   2. shadow results on real projects, proposals logged and never shown as
 *      fixes;
 *   3. a canary: a per-project allowlist starting with the founders'
 *      projects, an environment kill switch, and automatic demotion on any
 *      unsafe, falsely verified or rolled-back run;
 *   4. Tier 0 or 1 only. Auth, row security, destructive and credential
 *      classes stay human-approved forever.
 *
 * A promoted class still passes authorizeAutonomousFix, the mutation-boundary
 * revalidation and the three-check verification.
 */

/** Repair classes ("<finding base>:<action>") that may run without approval. Ships empty. */
export const PROMOTED_AI_REPAIR_CLASSES: ReadonlySet<string> = new Set<string>()

/** Whether a class may run without a person. Default deny. */
export function isPromoted(repairClass: string): boolean {
  if (process.env.AI_REPAIR_PROMOTION_DISABLED === 'true') return false
  return PROMOTED_AI_REPAIR_CLASSES.has(repairClass)
}
