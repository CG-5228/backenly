/**
 * The AI gateway (lib/ai/llm): which provider serves a call, what is sent,
 * what comes back, and how failures are classified. A scripted provider stands
 * in for the model; nothing here reaches a network.
 */

import Anthropic from '@anthropic-ai/sdk'
import OpenAI from 'openai'
import { aiAvailability, resolveProvider, routeFor, ALL_PURPOSES, BEDROCK_DEFAULT_MODEL } from '@/lib/ai/llm/config'
import { buildParams, shouldStream } from '@/lib/ai/llm/params'
import { capsFor, canonicalModel, clampEffort } from '@/lib/ai/llm/models'
import { AiError, classifyProviderError } from '@/lib/ai/llm/errors'
import { aiAvailability as gatewayAvailability, generate, setProviderForTests, setRetryDelayForTests, normalizeUsage } from '@/lib/ai/llm'
import { scriptedMessage, scriptedProvider } from '@/lib/ai/llm/providers/scripted'
import { memorySpendLedger, setSpendLedgerForTests } from '@/lib/ai/llm/spend'
import { createTokenScope, runInTokenScope } from '@/lib/ai/token-meter'

const user = (text: string): Anthropic.MessageParam => ({ role: 'user', content: text })

// Spend is reserved and settled on every call; these tests keep it in memory.
// tests/unit/llm-spend.spec.ts covers the reservation rules.
beforeEach(() => setSpendLedgerForTests(memorySpendLedger()))

afterEach(() => {
  setProviderForTests(null)
  setRetryDelayForTests(null)
  setSpendLedgerForTests(null)
})

describe('provider selection', () => {
  it('uses Bedrock only when asked, and only with a region', () => {
    expect(resolveProvider({ AI_PROVIDER: 'bedrock', BEDROCK_REGION: 'ap-south-1' })).toEqual({
      ok: true,
      config: { id: 'bedrock', region: 'ap-south-1' },
    })
    expect(resolveProvider({ AI_PROVIDER: 'bedrock', AWS_REGION: 'ap-south-1' })).toMatchObject({ ok: true })
    expect(resolveProvider({ AI_PROVIDER: 'bedrock' })).toMatchObject({ ok: false, reason: expect.stringMatching(/BEDROCK_REGION/) })
    // An AWS host always has a credential chain, so Bedrock is never inferred.
    expect(resolveProvider({ AWS_REGION: 'ap-south-1' })).toMatchObject({ ok: false })
  })

  it('infers a keyed provider, Claude first', () => {
    expect(resolveProvider({ ANTHROPIC_API_KEY: 'a', OPENAI_API_KEY: 'o' })).toMatchObject({ config: { id: 'anthropic' } })
    expect(resolveProvider({ OPENAI_API_KEY: 'o' })).toMatchObject({ config: { id: 'openai' } })
  })

  it('says plainly why AI is unavailable', () => {
    expect(aiAvailability({})).toEqual({ available: false, reason: expect.stringMatching(/No AI provider is configured/) })
    expect(aiAvailability({ AI_PROVIDER: 'gemini' })).toEqual({ available: false, reason: expect.stringMatching(/"gemini"/) })
    expect(aiAvailability({ AI_PROVIDER: 'anthropic' })).toEqual({ available: false, reason: expect.stringMatching(/ANTHROPIC_API_KEY/) })
  })
})

describe('routing', () => {
  it('routes every purpose to Opus 4.6 on Bedrock by default', () => {
    for (const p of ALL_PURPOSES) expect(routeFor(p, 'bedrock', {}).model).toBe(BEDROCK_DEFAULT_MODEL)
    expect(BEDROCK_DEFAULT_MODEL).toBe('global.anthropic.claude-opus-4-6-v1')
  })

  it('lets one purpose, or all of them, be overridden by environment', () => {
    const env = { AI_MODEL: 'model-all', AI_MODEL_BRAIN_CLASSIFY: 'model-classify' }
    expect(routeFor('brain.classify', 'bedrock', env).model).toBe('model-classify')
    expect(routeFor('brain.agent', 'bedrock', env).model).toBe('model-all')
  })

  it('routes the architect without thinking and with room for a whole spec', () => {
    expect(routeFor('brain.architect', 'bedrock', {})).toMatchObject({ thinking: false, effort: 'high', maxTokens: 16000 })
    expect(routeFor('brain.answer', 'bedrock', {})).toMatchObject({ thinking: false, effort: 'medium' })
    // On OpenAI both keep the model those calls always used: the smart one.
    expect(routeFor('brain.architect', 'openai', { OPENAI_MODEL: 'smart' }).model).toBe('smart')
    expect(routeFor('brain.answer', 'openai', { OPENAI_MODEL: 'smart' }).model).toBe('smart')
  })

  it('keeps the older OpenAI variables working', () => {
    const env = { OPENAI_MODEL: 'smart', OPENAI_MODEL_FAST: 'fast', AUTONOMY_FIX_MODEL: 'fixer', AUTONOMY_DIAGNOSIS_MODEL: 'diag' }
    expect(routeFor('brain.classify', 'openai', env).model).toBe('fast')
    expect(routeFor('brain.agent', 'openai', env).model).toBe('smart')
    expect(routeFor('build.fix_author', 'openai', env).model).toBe('fixer')
    expect(routeFor('autonomy.investigate', 'openai', env).model).toBe('diag')
  })
})

describe('models', () => {
  it('treats Bedrock and first-party ids as one model', () => {
    expect(canonicalModel('global.anthropic.claude-opus-4-6-v1')).toBe('claude-opus-4-6')
    expect(canonicalModel('anthropic.claude-opus-4-6-v1:0')).toBe('claude-opus-4-6')
    expect(capsFor('global.anthropic.claude-opus-4-6-v1').cacheMinTokens).toBe(4096)
  })

  it('never asks a model for an effort it does not accept', () => {
    expect(clampEffort('max', capsFor('claude-opus-4-6'))).toBe('max')
    expect(clampEffort('max', { efforts: ['low', 'medium', 'high'], cacheMinTokens: 1024, adaptiveThinking: true })).toBe('high')
  })
})

describe('the request', () => {
  const route = (over: Partial<ReturnType<typeof routeFor>> = {}) => ({ ...routeFor('brain.agent', 'bedrock', {}), ...over })

  it('always carries an output ceiling, which a call may lower and never raise', () => {
    expect(buildParams(route(), { purpose: 'brain.agent', messages: [user('x')] }).max_tokens).toBe(16000)
    expect(buildParams(route(), { purpose: 'brain.agent', messages: [user('x')], maxTokens: 500 }).max_tokens).toBe(500)
    expect(buildParams(route(), { purpose: 'brain.agent', messages: [user('x')], maxTokens: 999_999 }).max_tokens).toBe(16000)
  })

  it('caches by explicit breakpoints only, on the system block and the last tool', () => {
    const tool = (name: string): Anthropic.Tool => ({ name, input_schema: { type: 'object', properties: {} } })
    const p = buildParams(route(), { purpose: 'brain.agent', system: 'S', messages: [user('x')], tools: [tool('a'), tool('b')] })
    expect(p.system).toEqual([{ type: 'text', text: 'S', cache_control: { type: 'ephemeral' } }])
    expect((p.tools![0] as any).cache_control).toBeUndefined()
    expect((p.tools![1] as any).cache_control).toEqual({ type: 'ephemeral' })
    // Bedrock's Opus 4.6 integration rejects these with a 400.
    expect(p).not.toHaveProperty('cache_control')
    expect(p).not.toHaveProperty('temperature')
  })

  it("sends a call's own context as a second, uncached system block", () => {
    const p = buildParams(route(), { purpose: 'brain.agent', system: 'S', context: 'C', messages: [user('x')] })
    expect(p.system).toEqual([
      { type: 'text', text: 'S', cache_control: { type: 'ephemeral' } },
      { type: 'text', text: 'C' },
    ])
  })

  it("caches a tool loop's transcript at its last block, without marking the caller's messages", () => {
    const tool: Anthropic.Tool = { name: 'a', input_schema: { type: 'object', properties: {} } }
    const results: Anthropic.MessageParam = {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 't1', content: '{"ok":true}' }],
    }
    const messages: Anthropic.MessageParam[] = [
      user('build it'),
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'a', input: {} }] },
      results,
    ]
    const p = buildParams(route(), { purpose: 'brain.agent', system: 'S', tools: [tool], messages, cacheConversation: true })
    const last = p.messages[p.messages.length - 1].content as Array<Record<string, unknown>>
    expect(last[0].cache_control).toEqual({ type: 'ephemeral' })
    // The transcript the loop keeps appending to stays unmarked, so the next
    // call moves the breakpoint forward instead of piling them up.
    expect((results.content as Array<Record<string, unknown>>)[0].cache_control).toBeUndefined()
    // System, last tool, last message: three of the four the API allows.
    expect(JSON.stringify(p).split('"cache_control"').length - 1).toBe(3)

    // A plain-text last message becomes a block so it can carry the marker.
    const q = buildParams(route(), { purpose: 'brain.agent', messages: [user('hi')], cacheConversation: true })
    expect(q.messages[0].content).toEqual([{ type: 'text', text: 'hi', cache_control: { type: 'ephemeral' } }])
  })

  it('thinks only where the purpose asks, and never with a forced tool', () => {
    expect(buildParams(route(), { purpose: 'brain.agent', messages: [user('x')] }).thinking).toEqual({ type: 'adaptive' })
    const classify = routeFor('brain.classify', 'bedrock', {})
    expect(buildParams(classify, { purpose: 'brain.classify', messages: [user('x')] }).thinking).toBeUndefined()
    const forced = buildParams(route(), {
      purpose: 'brain.agent',
      messages: [user('x')],
      tools: [{ name: 't', input_schema: { type: 'object', properties: {} } }],
      toolChoice: { type: 'tool', name: 't' },
    })
    expect(forced.thinking).toBeUndefined()
  })

  it('asks for JSON with output_config.format, and sets effort', () => {
    const schema = { type: 'object', properties: { a: { type: 'string' } } }
    const p = buildParams(route(), { purpose: 'brain.agent', messages: [user('x')], jsonSchema: schema })
    expect(p.output_config).toEqual({ effort: 'high', format: { type: 'json_schema', schema } })
  })

  it('refuses a prefilled assistant turn before sending it', () => {
    expect(() =>
      buildParams(route(), { purpose: 'brain.agent', messages: [user('x'), { role: 'assistant', content: '{' }] }),
    ).toThrow(/prefill/)
  })

  it('streams thinking and long outputs, so a slow answer cannot time out the request', () => {
    expect(shouldStream(route(), 16000)).toBe(true)
    expect(shouldStream(routeFor('brain.classify', 'bedrock', {}), 1024)).toBe(false)
  })
})

describe('generate', () => {
  it('returns text, usage with cache reads and writes kept apart, and its cost', async () => {
    const provider = scriptedProvider([
      scriptedMessage({ text: 'hello', usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 5000, cache_creation_input_tokens: 0 } }),
    ])
    setProviderForTests(provider)
    const r = await generate({ purpose: 'brain.classify', system: 'S', messages: [user('hi')] })
    expect(r.text).toBe('hello')
    expect(r.usage).toEqual({
      promptTokens: 5100,
      inputTokens: 100,
      cacheReadTokens: 5000,
      cacheWrite5mTokens: 0,
      cacheWrite1hTokens: 0,
      outputTokens: 20,
    })
    // (100 + 5000 * 0.1) * $5/M + 20 * $25/M
    expect(r.costUsd).toBeCloseTo(0.0035, 6)
    expect(provider.calls[0].opts.stream).toBe(false)
  })

  it('parses JSON, and calls a cut-off or malformed answer invalid while keeping its usage', async () => {
    setProviderForTests(scriptedProvider([scriptedMessage({ text: '{"a":"b"}' })]))
    expect((await generate({ purpose: 'brain.classify', messages: [user('x')], jsonSchema: { type: 'object' } })).json).toEqual({ a: 'b' })

    setProviderForTests(scriptedProvider([scriptedMessage({ text: '{"a":', stopReason: 'max_tokens' })]))
    const cut = await generate({ purpose: 'brain.classify', messages: [user('x')], jsonSchema: { type: 'object' } }).catch((e) => e)
    expect(cut).toBeInstanceOf(AiError)
    expect(cut).toMatchObject({ kind: 'output_invalid', consumption: 'ran' })
    expect(cut.usage.outputTokens).toBe(5)
  })

  it('reports a refusal as one, with the run it cost', async () => {
    setProviderForTests(scriptedProvider([scriptedMessage({ text: '', stopReason: 'refusal' })]))
    const e = await generate({ purpose: 'brain.agent', messages: [user('x')] }).catch((x) => x)
    expect(e).toMatchObject({ kind: 'refused', consumption: 'ran' })
  })

  it('retries a request rejected before inference, and never one that may have run', async () => {
    setRetryDelayForTests(() => 0)
    const throttled = new Anthropic.RateLimitError(429, { type: 'error' }, 'slow down', new Headers())
    const ok = scriptedMessage({ text: 'done' })
    setProviderForTests(scriptedProvider([throttled, ok]))
    expect((await generate({ purpose: 'brain.classify', messages: [user('x')] })).attempts).toBe(2)

    const timeout = new Anthropic.APIConnectionTimeoutError()
    const provider = scriptedProvider([timeout, ok])
    setProviderForTests(provider)
    const e = await generate({ purpose: 'brain.classify', messages: [user('x')] }).catch((x) => x)
    expect(e).toMatchObject({ kind: 'timeout', consumption: 'unknown', attempts: 1 })
    expect(provider.calls).toHaveLength(1)
  })

  it('reports every call that ran to the open credit meter, in cost-weighted tokens', async () => {
    setProviderForTests(
      scriptedProvider([
        scriptedMessage({ text: 'a', usage: { input_tokens: 100, output_tokens: 20, cache_creation_input_tokens: 4000 } }),
        scriptedMessage({ text: '', stopReason: 'refusal', usage: { input_tokens: 50, output_tokens: 10, cache_read_input_tokens: 4000 } }),
      ]),
    )
    const scope = createTokenScope()
    await runInTokenScope(scope, async () => {
      await generate({ purpose: 'brain.agent', messages: [user('x')] })
      await generate({ purpose: 'brain.agent', messages: [user('y')] }).catch(() => {})
    })
    // 100 + 4000 written at 1.25 + 20 out; then a refusal, which still ran:
    // 50 + 4000 read at 0.1 + 10 out.
    expect(scope.tokens).toBe(5120 + 460)
  })

  it('reports nothing for a call the provider refused before running it', async () => {
    setProviderForTests(scriptedProvider([new Anthropic.PermissionDeniedError(403, {}, 'no access', new Headers())]))
    const scope = createTokenScope()
    await runInTokenScope(scope, () => generate({ purpose: 'brain.agent', messages: [user('x')] }).catch(() => undefined))
    expect(scope.tokens).toBe(0)
  })

  it('names the model a failed request was routed to, so a run it cost can be priced', async () => {
    setProviderForTests(scriptedProvider([scriptedMessage({ text: '', stopReason: 'refusal' })]))
    const e = await generate({ purpose: 'brain.agent', messages: [user('x')] }).catch((x) => x)
    expect(e.model).toBe(routeFor('brain.agent', 'anthropic').model)
  })

  it("counts a test's scripted provider as configured", () => {
    setProviderForTests(scriptedProvider([]))
    expect(gatewayAvailability({})).toEqual({ available: true, provider: 'scripted' })
    setProviderForTests(null)
    expect(gatewayAvailability({})).toMatchObject({ available: false })
  })

  it('fails as not configured, with the reason, when nothing is set up', async () => {
    const saved = { ...process.env }
    for (const k of ['AI_PROVIDER', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY']) delete process.env[k]
    try {
      const e = await generate({ purpose: 'brain.classify', messages: [user('x')] }).catch((x) => x)
      expect(e).toMatchObject({ kind: 'not_configured', consumption: 'none' })
      expect(e.userMessage).toBe('No AI provider is configured on this deployment.')
    } finally {
      process.env = saved
    }
  })
})

describe('usage', () => {
  it('splits cache writes by lifetime when the provider reports it', () => {
    const u = normalizeUsage({
      input_tokens: 10,
      output_tokens: 1,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 300,
      cache_creation: { ephemeral_5m_input_tokens: 100, ephemeral_1h_input_tokens: 200 },
    } as any)
    expect(u).toMatchObject({ promptTokens: 310, cacheWrite5mTokens: 100, cacheWrite1hTokens: 200 })
  })
})

describe('error classification', () => {
  const c = (err: unknown) => classifyProviderError(err, 'bedrock')
  const h = new Headers()

  it('separates a throttle from an exhausted account', () => {
    expect(c(new Anthropic.RateLimitError(429, {}, 'Too many requests', h))).toMatchObject({ kind: 'rate_limited', retryable: true, consumption: 'none' })
    expect(c(new OpenAI.RateLimitError(429, { code: 'insufficient_quota' }, 'quota', h))).toMatchObject({ kind: 'quota_exhausted', retryable: false })
    const lowCredit = { type: 'error', error: { type: 'invalid_request_error', message: 'Your credit balance is too low to access the API.' } }
    expect(c(new Anthropic.BadRequestError(400, lowCredit, undefined, h))).toMatchObject({ kind: 'quota_exhausted' })
    // Any other 400 is a malformed request, not an empty account.
    const invalid = { type: 'error', error: { type: 'invalid_request_error', message: 'max_tokens: must be positive' } }
    expect(c(new Anthropic.BadRequestError(400, invalid, undefined, h))).toMatchObject({ kind: 'invalid_request' })
  })

  it('reads credentials and model-access refusals as access denied', () => {
    expect(c(new Anthropic.PermissionDeniedError(403, {}, "You don't have access to the model", h))).toMatchObject({ kind: 'access_denied', consumption: 'none' })
    expect(c(new Anthropic.AuthenticationError(401, {}, 'bad key', h))).toMatchObject({ kind: 'access_denied' })
  })

  it('treats an overload as refused before inference, and other server errors as unknown', () => {
    expect(c(new Anthropic.InternalServerError(529, {}, 'Overloaded', h))).toMatchObject({ kind: 'unavailable', consumption: 'none', retryable: true })
    expect(c(new Anthropic.InternalServerError(500, {}, 'boom', h))).toMatchObject({ kind: 'unavailable', consumption: 'unknown', retryable: false })
  })

  it('never claims a timeout or dropped connection cost nothing', () => {
    expect(c(new Anthropic.APIConnectionTimeoutError())).toMatchObject({ kind: 'timeout', consumption: 'unknown' })
    expect(c(new Anthropic.APIConnectionError({ message: 'reset' }))).toMatchObject({ kind: 'unavailable', consumption: 'unknown' })
    expect(c(new Error('anything'))).toMatchObject({ kind: 'unavailable', consumption: 'unknown' })
  })
})
