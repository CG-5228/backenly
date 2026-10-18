import crypto from 'crypto'

/**
 * The evidence a finding carries, as one hash: the detector's output without
 * the fields later passes add to it (a diagnosis, investigation bookkeeping, an
 * unverified-change record). A diagnosis or a proposal is kept while it
 * matches; new evidence makes both stale.
 */
export function evidenceFingerprint(type: string, details: Record<string, unknown>): string {
  const evidence = { ...details }
  for (const key of ['diagnosis', 'investigation', 'appliedUnverified', 'rollbackData', 'proposal']) delete evidence[key]
  const stable = JSON.stringify(evidence, Object.keys(evidence).sort())
  return crypto.createHash('sha256').update(`${type}\n${stable}`).digest('hex').slice(0, 32)
}
