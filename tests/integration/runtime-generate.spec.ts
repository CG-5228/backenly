/**
 * /v1/{projectId}/ai/generate, through lib/ai/runtime-generate.ts.
 *
 * Real database for the project, its billing account lookup and the usage row
 * each call writes; the model is scripted. Spend reservations use the
 * gateway's in-memory ledger (tests/integration/ai-spend-ledger.spec.ts covers
 * the Postgres one).
 */

import crypto from 'crypto'
import { prisma } from '@/lib/db/prisma'
import { AiError, setProviderForTests } from '@/lib/ai/llm'
import { scriptedMessage, scriptedProvider } from '@/lib/ai/llm/providers/scripted'
import { memorySpendLedger, setSpendLedgerForTests } from '@/lib/ai/llm/spend'
import { generateForProject, purposeForModel } from '@/lib/ai/runtime-generate'

let ownerId: string
let projectId: string

beforeAll(async () => {
  ownerId = (await prisma.user.create({
    data: { email: `runtime-gen-${crypto.randomBytes(6).toString('hex')}@example.test`, password: 'not-a-real-hash', name: 'gen' },
  })).id
  projectId = (await prisma.project.create({ data: { name: 'runtime-generate', userId: ownerId } })).id
}, 60_000)

beforeEach(() => setSpendLedgerForTests(memorySpendLedger()))
afterEach(() => {
  setProviderForTests(null)
  setSpendLedgerForTests(null)
})

afterAll(async () => {
  await prisma.project.deleteMany({ where: { userId: ownerId } }).catch(() => {})
  await prisma.user.delete({ where: { id: ownerId } }).catch(() => {})
}, 60_000)

describe('model aliases', () => {
  it('serves "fast" as the fast route and everything else, old model names included, as the default', () => {
    expect(purposeForModel('fast')).toEqual({ alias: 'fast', purpose: 'runtime.fast' })
    for (const m of [undefined, 'default', 'gpt-4.1', 'gpt-4o-mini', 'claude-opus-4-6', 'anything']) {
      expect(purposeForModel(m)).toEqual({ alias: 'default', purpose: 'runtime.generate' })
    }
  })
})

describe('generating for a project', () => {
  it('runs the alias on the deployment model, caps the output and records the usage', async () => {
    const provider = scriptedProvider([
      scriptedMessage({ text: 'A haiku about tables.', usage: { input_tokens: 12, output_tokens: 7 } }),
    ])
    setProviderForTests(provider)

    const r = await generateForProject({ projectId, prompt: 'write a haiku', model: 'gpt-4.1', maxTokens: 4000 })

    expect(r).toEqual({
      ok: true,
      data: {
        content: 'A haiku about tables.',
        model: expect.any(String),
        usage: { promptTokens: 12, completionTokens: 7, totalTokens: 19 },
      },
    })
    const sent = provider.calls[0].params
    // A caller can no longer pick the model on the platform's account.
    expect(sent.model).not.toBe('gpt-4.1')
    expect(sent.max_tokens).toBeLessThanOrEqual(4096)
    expect(sent).not.toHaveProperty('temperature')

    let row = null
    for (let i = 0; i < 50 && !row; i++) {
      row = await prisma.aiUsage.findFirst({ where: { projectId, endpoint: 'runtime-generate' } })
      if (!row) await new Promise((res) => setTimeout(res, 100))
    }
    expect(row).toMatchObject({ promptTokens: 12, completionTokens: 7 })
  }, 60_000)

  it('asks for less effort under "fast"', async () => {
    const provider = scriptedProvider([scriptedMessage({ text: 'ok' })])
    setProviderForTests(provider)
    await generateForProject({ projectId, prompt: 'x', model: 'fast' })
    expect(provider.calls[0].params.output_config).toMatchObject({ effort: 'low' })
  }, 60_000)

  it('answers a provider failure with a code and plain words, never the provider message', async () => {
    setProviderForTests(
      scriptedProvider([new AiError('quota_exhausted', 'insufficient_quota: account sk-... has no credit', { consumption: 'none' })]),
    )
    const r = await generateForProject({ projectId, prompt: 'x' })
    expect(r).toMatchObject({ ok: false, code: 'AI_UNAVAILABLE', status: 503 })
    expect((r as { message: string }).message).not.toMatch(/insufficient_quota|sk-/)
  }, 60_000)
})
