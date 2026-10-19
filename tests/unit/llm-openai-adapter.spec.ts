/**
 * The OpenAI provider behind the gateway translates the Anthropic Messages
 * shape both ways. What has no OpenAI form is refused before sending, never
 * approximated.
 */

import type Anthropic from '@anthropic-ai/sdk'
import { fromOpenAI, openaiProvider, toOpenAI } from '@/lib/ai/llm/providers/openai'
import { AiError } from '@/lib/ai/llm/errors'

const base = (over: Partial<Anthropic.MessageCreateParamsNonStreaming> = {}): Anthropic.MessageCreateParamsNonStreaming => ({
  model: 'gpt-4.1',
  max_tokens: 100,
  messages: [{ role: 'user', content: 'hi' }],
  ...over,
})

describe('toOpenAI', () => {
  it('sends system as a system message and keeps the output ceiling', () => {
    const body = toOpenAI(base({ system: [{ type: 'text', text: 'Be brief.' }] }))
    expect(body.messages[0]).toEqual({ role: 'system', content: 'Be brief.' })
    expect(body.max_tokens).toBe(100)
  })

  it('turns a tool round trip into tool_calls and tool messages, in order', () => {
    const body = toOpenAI(
      base({
        messages: [
          { role: 'user', content: 'list tables' },
          {
            role: 'assistant',
            content: [
              { type: 'thinking', thinking: 'hm', signature: 's' },
              { type: 'text', text: 'Checking.' },
              { type: 'tool_use', id: 'call_1', name: 'list_tables', input: { schema: 'x' } },
            ],
          },
          {
            role: 'user',
            content: [
              { type: 'tool_result', tool_use_id: 'call_1', content: [{ type: 'text', text: '["a"]' }] },
              { type: 'text', text: 'and now?' },
            ],
          },
        ],
        tools: [{ name: 'list_tables', description: 'List tables', input_schema: { type: 'object', properties: {} } }],
        tool_choice: { type: 'any' },
      }),
    )
    expect(body.messages).toEqual([
      { role: 'user', content: 'list tables' },
      {
        role: 'assistant',
        content: 'Checking.',
        tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'list_tables', arguments: '{"schema":"x"}' } }],
      },
      { role: 'tool', tool_call_id: 'call_1', content: '["a"]' },
      { role: 'user', content: [{ type: 'text', text: 'and now?' }] },
    ])
    expect(body.tools).toEqual([
      { type: 'function', function: { name: 'list_tables', description: 'List tables', parameters: { type: 'object', properties: {} } } },
    ])
    expect(body.tool_choice).toBe('required')
  })

  it('asks for JSON with its own response format', () => {
    const schema = { type: 'object' }
    const body = toOpenAI(base({ output_config: { effort: 'high', format: { type: 'json_schema', schema } } }))
    expect(body.response_format).toEqual({ type: 'json_schema', json_schema: { name: 'response', schema, strict: false } })
  })

  it('refuses what it cannot translate', () => {
    expect(() =>
      toOpenAI(base({ messages: [{ role: 'user', content: [{ type: 'document', source: { type: 'text', media_type: 'text/plain', data: 'x' } }] }] })),
    ).toThrow(AiError)
  })
})

describe('fromOpenAI', () => {
  const completion = (over: Record<string, unknown>) =>
    ({
      id: 'c1',
      object: 'chat.completion',
      created: 0,
      model: 'gpt-4.1',
      choices: [{ index: 0, finish_reason: 'stop', logprobs: null, message: { role: 'assistant', content: 'ok', refusal: null } }],
      usage: { prompt_tokens: 1000, completion_tokens: 50, total_tokens: 1050, prompt_tokens_details: { cached_tokens: 800 } },
      ...over,
    }) as any

  it('reports cached prompt tokens as cache reads, apart from fresh input', () => {
    const m = fromOpenAI(completion({}))
    expect(m.usage).toMatchObject({ input_tokens: 200, cache_read_input_tokens: 800, cache_creation_input_tokens: 0, output_tokens: 50 })
    expect(m.content).toEqual([{ type: 'text', text: 'ok', citations: null }])
    expect(m.stop_reason).toBe('end_turn')
  })

  it('turns tool calls into tool_use blocks', () => {
    const m = fromOpenAI(
      completion({
        choices: [
          {
            index: 0,
            finish_reason: 'tool_calls',
            logprobs: null,
            message: { role: 'assistant', content: null, refusal: null, tool_calls: [{ id: 'call_9', type: 'function', function: { name: 't', arguments: '{"a":1}' } }] },
          },
        ],
      }),
    )
    expect(m.content).toEqual([{ type: 'tool_use', id: 'call_9', name: 't', input: { a: 1 } }])
    expect(m.stop_reason).toBe('tool_use')
  })

  it('maps truncation and content filtering to the matching stop reasons', () => {
    const at = (finish_reason: string) =>
      fromOpenAI(completion({ choices: [{ index: 0, finish_reason, logprobs: null, message: { role: 'assistant', content: 'x', refusal: null } }] })).stop_reason
    expect(at('length')).toBe('max_tokens')
    expect(at('content_filter')).toBe('refusal')
  })

  it('calls malformed tool arguments invalid output, which ran', () => {
    expect(() =>
      fromOpenAI(
        completion({
          choices: [
            {
              index: 0,
              finish_reason: 'tool_calls',
              logprobs: null,
              message: { role: 'assistant', content: null, refusal: null, tool_calls: [{ id: 'x', type: 'function', function: { name: 't', arguments: '{bad' } }] },
            },
          ],
        }),
      ),
    ).toThrow(expect.objectContaining({ kind: 'output_invalid', consumption: 'ran' }))
  })
})

describe('openaiProvider', () => {
  it('sends with the gateway timeout and no SDK retries', async () => {
    const seen: any[] = []
    const client = {
      chat: {
        completions: {
          create: async (body: unknown, opts: unknown) => {
            seen.push({ body, opts })
            return {
              id: 'c',
              model: 'gpt-4.1',
              choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'hi' } }],
              usage: { prompt_tokens: 1, completion_tokens: 1 },
            }
          },
        },
      },
    } as any
    const m = await openaiProvider('k', client).send(base(), { timeoutMs: 1234, stream: false })
    expect(seen[0].opts).toMatchObject({ timeout: 1234, maxRetries: 0 })
    expect((m.content[0] as Anthropic.TextBlock).text).toBe('hi')
  })
})
