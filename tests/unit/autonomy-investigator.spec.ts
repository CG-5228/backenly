/**
 * The autonomy investigator (lib/autonomy/investigator.ts): its tool loop, its
 * tool budget, and the checks its answer must pass. A scripted provider stands
 * in for Claude and a stub for the probes; the database-backed run is in
 * tests/integration/escalation-investigation.spec.ts.
 */

import { setProviderForTests } from '@/lib/ai/llm'
import { scriptedMessage, scriptedProvider } from '@/lib/ai/llm/providers/scripted'
import { memorySpendLedger, setSpendLedgerForTests } from '@/lib/ai/llm/spend'
import { investigateFinding, validateAnswer, MAX_TOOL_CALLS, type InvestigationInput } from '@/lib/autonomy/investigator'
import { evidenceFingerprint, isDue } from '@/lib/autonomy/escalation-diagnosis'
import { proposableFor } from '@/lib/autonomy/ai-proposals'

const catalog = [{ name: 'orders', columns: ['id', 'customer_id', 'total'] }]
const input: InvestigationInput = {
  projectId: 'p1',
  finding: { type: 'missing_fk', severity: 'warning', status: 'pending_approval', detectedAt: new Date('2026-10-01T00:00:00Z'), summary: 'orders.customer_id has no FK', details: { tableName: 'orders' } },
  deterministic: null,
  catalog,
  recentActivity: [],
  priorAttempts: [],
}
const answer = (over: Record<string, unknown> = {}) =>
  scriptedMessage({
    text: JSON.stringify({
      verdict: 'explained',
      rootCause: 'orders.customer_id references customers but carries no constraint.',
      evidenceRefs: ['e1'],
      ruledOut: ['the table is missing'],
      recommendation: 'Add the foreign key.',
      proposedAction: null,
      riskNote: 'Existing orphan rows would block it.',
      namedTables: ['orders'],
      namedColumns: ['orders.customer_id'],
      ...over,
    }),
  })

beforeEach(() => setSpendLedgerForTests(memorySpendLedger()))
afterEach(() => {
  setProviderForTests(null)
  setSpendLedgerForTests(null)
})

describe('checking an answer', () => {
  it('accepts evidence that ran and names that exist', () => {
    expect(validateAnswer({ verdict: 'explained', evidenceRefs: ['finding', 'e1'], namedTables: ['orders'], namedColumns: ['orders.total'] }, [{ id: 'e1', tool: 'probe:x', input: {}, outcome: 'ok' }], catalog)).toEqual({ ok: true, problems: [] })
  })

  it('rejects invented evidence, tables and columns, and an explanation without evidence', () => {
    const v = validateAnswer({ verdict: 'explained', evidenceRefs: ['e9'], namedTables: ['customers'], namedColumns: ['orders.email', 'total'] }, [], catalog)
    expect(v.ok).toBe(false)
    expect(v.problems).toEqual([
      'cites evidence "e9" that was never gathered',
      'names table "customers", which does not exist',
      'names column "orders.email", which does not exist',
      'names column "total", which does not exist',
    ])
    expect(validateAnswer({ verdict: 'explained', evidenceRefs: [], namedTables: [], namedColumns: [] }, [], catalog).problems).toEqual([
      'claims an explanation without citing evidence',
    ])
  })
})

describe('investigating', () => {
  it('runs the probes it asks for, records each as evidence, and keeps a checked answer', async () => {
    const provider = scriptedProvider([
      scriptedMessage({ thinking: 'check the table', toolUse: [{ id: 't1', name: 'run_probe', input: { probe: 'table_exists', table: 'orders' } }] }),
      answer(),
    ])
    setProviderForTests(provider)
    const ran: string[] = []
    const r = await investigateFinding(input, async (probe, table) => {
      ran.push(`${probe}:${table}`)
      return { outcome: 'exists' }
    }, ['table_exists'])

    expect(ran).toEqual(['table_exists:orders'])
    expect(r.evidence).toEqual([{ id: 'e1', tool: 'probe:table_exists', input: { probe: 'table_exists', table: 'orders' }, outcome: 'exists' }])
    expect(r).toMatchObject({ verdict: 'explained', validation: { ok: true, problems: [] } })
    // Investigations are the deployment's own spend, at the deepest effort.
    expect(provider.calls[0].params.output_config).toMatchObject({ effort: 'max', format: { type: 'json_schema' } })
    expect(provider.calls[0].params.thinking).toEqual({ type: 'adaptive' })
    // The brief carries names, never a probe's raw rows.
    expect(JSON.stringify(provider.calls[0].params.messages)).toContain('orders(id, customer_id, total)')
  })

  it('stores an answer that cites what never ran as uncertain, with the reason', async () => {
    setProviderForTests(scriptedProvider([answer({ evidenceRefs: ['e4'], namedTables: ['customers'] })]))
    const r = await investigateFinding(input, async () => ({ outcome: 'x' }), ['table_exists'])
    expect(r.verdict).toBe('uncertain')
    expect(r.validation.problems).toEqual([
      'cites evidence "e4" that was never gathered',
      'names table "customers", which does not exist',
    ])
  })

  it(`stops running tools after ${MAX_TOOL_CALLS} and asks for the answer`, async () => {
    const many = Array.from({ length: MAX_TOOL_CALLS + 2 }, (_, i) => ({ id: `t${i}`, name: 'list_columns', input: { table: 'orders' } }))
    const provider = scriptedProvider([scriptedMessage({ toolUse: many }), answer({ evidenceRefs: ['e1'] })])
    setProviderForTests(provider)
    const r = await investigateFinding(input, async () => ({ outcome: 'x' }), [])
    expect(r.evidence).toHaveLength(MAX_TOOL_CALLS)
    const answered = provider.calls[1].params.messages.at(-1)!.content as Array<{ is_error?: boolean }>
    expect(answered.filter((b) => b.is_error)).toHaveLength(2)
  })
})

// On staging with live Claude, an investigator told only "an action name and its
// parameters" proposed the drift detector's own SQL through apply_migration,
// which no proposal may run. The model is now offered the typed repairs that
// apply to the finding, and its answer is held to them.
describe('what it may propose', () => {
  const missingColumn = { type: 'intent_drift', details: { tableName: 'orders', columnName: 'placed_at', driftKind: 'missing_column', requested: 'timestamp' } }
  const schemaOf = (call: { params: { output_config?: unknown } }) =>
    (call.params.output_config as { format: { schema: { properties: Record<string, any> } } }).format.schema

  it('offers ADD_COLUMN for a missing column, and nothing for any other finding', () => {
    const offered = proposableFor(missingColumn)
    expect(offered.map((p) => p.action)).toEqual(['ADD_COLUMN'])
    expect(offered[0].params).toMatchObject({ required: ['tableName', 'columnName', 'columnType'], additionalProperties: false })
    expect(proposableFor({ type: 'intent_drift', details: { tableName: 'orders', columnName: 'placed_at', driftKind: 'type_drift' } })).toEqual([])
    expect(proposableFor({ type: 'missing_realtime_triggers_realtime', details: { tableName: 'posts' } })).toEqual([])
  })

  it('holds the answer to the offered actions and tells the model their exact parameters', async () => {
    const paramsJson = JSON.stringify({ tableName: 'orders', columnName: 'placed_at', columnType: 'timestamp' })
    const provider = scriptedProvider([answer({ proposedAction: { action: 'ADD_COLUMN', paramsJson } })])
    setProviderForTests(provider)
    const r = await investigateFinding({ ...input, proposable: proposableFor(missingColumn) }, async () => ({ outcome: 'x' }), [])

    expect(schemaOf(provider.calls[0]).properties.proposedAction.anyOf[1].properties.action.enum).toEqual(['ADD_COLUMN'])
    const brief = JSON.stringify(provider.calls[0].params.messages[0])
    expect(brief).toContain('- ADD_COLUMN: ')
    expect(brief).toContain('columnType')
    expect(r.proposedAction).toEqual({ action: 'ADD_COLUMN', paramsJson })
  })

  it('allows no proposal at all when no typed repair applies', async () => {
    const provider = scriptedProvider([answer()])
    setProviderForTests(provider)
    await investigateFinding(input, async () => ({ outcome: 'x' }), [])
    expect(schemaOf(provider.calls[0]).properties.proposedAction).toEqual({ type: 'null' })
    expect(JSON.stringify(provider.calls[0].params.messages[0])).toContain('proposedAction must be null')
  })
})

describe('when a finding is due', () => {
  it('investigates once per evidence, and again when the evidence changes', () => {
    const details = { tableName: 'orders' }
    const fp = evidenceFingerprint('missing_fk', details)
    expect(evidenceFingerprint('missing_fk', { ...details, diagnosis: { x: 1 }, investigation: { y: 2 } })).toBe(fp)
    expect(isDue(details, fp)).toBe(true)
    expect(isDue({ ...details, diagnosis: { fingerprint: fp } }, fp)).toBe(false)
    expect(isDue({ ...details, diagnosis: { fingerprint: 'older-evidence' } }, fp)).toBe(true)
  })

  it('waits out its backoff and gives up after three failed attempts', () => {
    const fp = 'f'
    const now = Date.parse('2026-10-11T12:00:00Z')
    expect(isDue({ investigation: { fingerprint: fp, attempts: 1, nextAt: '2026-10-11T12:10:00Z' } }, fp, now)).toBe(false)
    expect(isDue({ investigation: { fingerprint: fp, attempts: 1, nextAt: '2026-10-11T11:59:00Z' } }, fp, now)).toBe(true)
    expect(isDue({ investigation: { fingerprint: fp, attempts: 3 } }, fp, now)).toBe(false)
  })
})
