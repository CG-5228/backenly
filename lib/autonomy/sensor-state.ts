/**
 * WHAT THE LOOP COULD SEE ON ITS LAST PASS
 * ========================================
 *
 * A check that errored or was not run reports no problem, which looks exactly
 * like a healthy backend. The loop knows which of its checks ran on every pass
 * (the desired-state report carries `errors` and `disabled`), but it only
 * logged them, so a dashboard could say "no issues" while half the checks were
 * blind.
 *
 * This records the outcome of the latest pass per project, one row upserted per
 * pass, so a surface can say what was actually checked: "no issues detected by
 * N of M checks", which checks could not run, which are off on this install,
 * and whether the result is fresh at all. It never reruns a probe; reading it
 * is one indexed lookup.
 */

import { prisma } from '@/lib/db/prisma'
import type { DesiredStateReport } from './desired-state'
import { classifyProbeOutcomes, probeRunsFrom } from './sensor-health'

const PREF_TYPE = 'autonomy_sensors'
const PREF_KEY = 'latest'

export interface SensorState {
  /** When the pass that produced this ran (ISO). */
  at: string
  /** Every check the loop evaluates for this project. */
  total: number
  /** Checks that ran and could report. */
  ran: number
  /** Checks that threw: they could not report a problem even if there was one. */
  errored: Array<{ id: string; title: string; error: string }>
  /** Checks not run because a platform capability is missing on this install. */
  disabled: Array<{ id: string; title: string; reason: string }>
}

/**
 * Summarise a desired-state report into what was and was not checked, with the
 * same per-probe classification the authority gate uses (sensor-health.ts).
 * Firing history is not needed to say what ran, so none is passed.
 */
export function sensorStateFrom(report: DesiredStateReport): SensorState {
  const { probes } = classifyProbeOutcomes(probeRunsFrom(report), new Map())
  const errored = probes
    .filter((p) => p.status === 'errored')
    .map((p) => ({ id: p.id, title: p.title, error: (p.error ?? '').slice(0, 300) }))
  const disabled = probes
    .filter((p) => p.status === 'disabled')
    .map((p) => ({ id: p.id, title: p.title, reason: p.disabledReason ?? '' }))
  return {
    at: report.evaluatedAt,
    total: probes.length,
    ran: probes.length - errored.length - disabled.length,
    errored,
    disabled,
  }
}

/** Record the latest pass. Never throws: this is reporting, not control. */
export async function recordSensorState(projectId: string, report: DesiredStateReport): Promise<void> {
  try {
    const value = JSON.stringify(sensorStateFrom(report))
    await prisma.projectPreference.upsert({
      where: { projectId_type_key: { projectId, type: PREF_TYPE, key: PREF_KEY } },
      create: { projectId, type: PREF_TYPE, key: PREF_KEY, value, confidence: 1 },
      update: { value, lastSeen: new Date() },
    })
  } catch (err: any) {
    console.warn(`[SensorState] record failed for ${projectId}:`, err?.message ?? err)
  }
}

/**
 * The latest recorded pass, or null when none has been recorded or it cannot
 * be read. Never throws: a surface that cannot read this must say it does not
 * know, not fail.
 */
export async function loadSensorState(projectId: string): Promise<SensorState | null> {
  try {
    const row = await prisma.projectPreference.findUnique({
      where: { projectId_type_key: { projectId, type: PREF_TYPE, key: PREF_KEY } },
      select: { value: true },
    })
    if (!row) return null
    const parsed = JSON.parse(row.value) as SensorState
    return typeof parsed?.at === 'string' && typeof parsed?.total === 'number' ? parsed : null
  } catch {
    return null
  }
}
