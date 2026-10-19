/**
 * The brain's side of the AI gateway (lib/ai/brain/model.ts): the tool catalog
 * as its model is offered it, the conversation a turn sends, and what a failed
 * call means for the turn. tests/integration/brain-on-gateway.spec.ts runs the
 * whole turn against a real database.
 */

import { AiError, setProviderForTests, type AiErrorKind } from '@/lib/ai/llm'
import { BRAIN_MODEL_TOOLS } from '@/lib/ai/brain/tools'
import { conversationFor, modelFailureOf, toModelTool, toolResultBlock } from '@/lib/ai/brain/model'
import { runBrain, type BrainEvent } from '@/lib/ai/brain/agent'

describe('the tool catalog as the model is offered it', () => {
  const tools = BRAIN_MODEL_TOOLS.map(toModelTool)

  it('translates every tool, keeping its name, description and argument schema', () => {
    expect(tools).toHaveLength(BRAIN_MODEL_TOOLS.length)
    tools.forEach((tool, i) => {
      const source = BRAIN_MODEL_TOOLS[i].function
      expect(tool.name).toBe(source.name)
      expect(tool.description).toBe(source.description)
      expect(tool.input_schema).toEqual(source.parameters)
    })
  })

  it('offers only schemas and names a model accepts', () => {
    for (const tool of tools) {
      expect(tool.input_schema.type).toBe('object')
      expect(tool.name).toMatch(/^[a-zA-Z0-9_-]{1,64}$/)
    }
    expect(new Set(tools.map((t) => t.name)).size).toBe(tools.length)
  })
})

describe('the conversation a turn sends', () => {
  it('ends with the user message', () => {
    expect(conversationFor([], 'hi')).toEqual([{ role: 'user', content: 'hi' }])
  })

  it('opens on a user turn and carries no blank turns', () => {
    const sent = conversationFor(
      [
        { role: 'assistant', content: 'Welcome back.' },
        { role: 'user', content: 'add a posts table' },
        { role: 'assistant', content: '   ' },
        { role: 'assistant', content: 'Done: posts.' },
      ],
      'now add comments',
    )
    expect(sent).toEqual([
      { role: 'user', content: 'add a posts table' },
      { role: 'assistant', content: 'Done: posts.' },
      { role: 'user', content: 'now add comments' },
    ])
  })
})

describe('what a failed model call means for the turn', () => {
  const fail = (kind: AiErrorKind) => modelFailureOf(new AiError(kind, 'detail', { consumption: 'none' }))

  it('never calls an empty account or a spending limit a rate limit', () => {
    for (const kind of ['not_configured', 'quota_exhausted', 'access_denied', 'spend_limit', 'spend_unavailable', 'credits_exhausted'] as const) {
      expect(fail(kind)).toMatchObject({ code: 'AI_UNAVAILABLE', retryable: false })
    }
    expect(fail('quota_exhausted').reason).toMatch(/out of quota or credit/)
    expect(fail('spend_limit').reason).toMatch(/monthly AI spending limit/)
  })

  it('keeps the transient failures retryable', () => {
    expect(fail('rate_limited')).toEqual({ code: 'RATE_LIMITED', reason: 'the AI provider rate-limited us', retryable: true })
    expect(fail('timeout')).toMatchObject({ code: 'MODEL_TIMEOUT', retryable: true })
    expect(fail('unavailable')).toMatchObject({ code: 'MODEL_ERROR', retryable: true })
  })

  it('does not invite a retry that would be refused the same way', () => {
    expect(fail('refused')).toMatchObject({ code: 'MODEL_ERROR', retryable: false })
    expect(fail('invalid_request')).toMatchObject({ code: 'MODEL_ERROR', retryable: false })
  })

  it('treats anything else as a model error', () => {
    expect(modelFailureOf(new Error('boom'))).toMatchObject({ code: 'MODEL_ERROR', retryable: true })
  })
})

describe('a tool outcome answered to the model', () => {
  it('marks a refusal as an error result, and only a refusal', () => {
    expect(toolResultBlock('t1', { ok: false, summary: 'no' }, true)).toEqual({
      type: 'tool_result',
      tool_use_id: 't1',
      content: '{"ok":false,"summary":"no"}',
      is_error: true,
    })
    expect(toolResultBlock('t2', { ok: true, summary: 'yes' }, false)).not.toHaveProperty('is_error')
  })
})

describe('a turn with no AI provider configured', () => {
  const KEYS = ['AI_PROVIDER', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY'] as const
  let saved: Partial<Record<(typeof KEYS)[number], string>>

  beforeEach(() => {
    setProviderForTests(null)
    saved = {}
    for (const k of KEYS) {
      saved[k] = process.env[k]
      delete process.env[k]
    }
  })

  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k]
    }
  })

  // This suite runs without a database. Reading the project or its history
  // would throw, so the turn passing here also shows it stopped before both.
  it('says so and stops before reading or changing anything', async () => {
    const events: BrainEvent[] = []
    const result = await runBrain({ projectId: 'no-such-project', userId: 'u', message: 'add a posts table' }, (e) => events.push(e))

    expect(result).toMatchObject({
      success: false,
      failureCode: 'AI_UNAVAILABLE',
      retryable: false,
      toolsRun: [],
      applied: [],
      tokensUsed: 0,
    })
    expect(result.summary).toMatch(/no AI provider is configured on this deployment\. Nothing was modified\./)
    expect(result.summary).toMatch(/No AI provider is configured\. Set AI_PROVIDER=bedrock/)
    expect(events.find((e) => e.type === 'final')).toMatchObject({ summary: result.summary })
  })
})
