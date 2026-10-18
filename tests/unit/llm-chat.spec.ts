/**
 * The gateway's older call shape (lib/ai/llm/chat.ts), its text streaming, and
 * embedding availability. A scripted provider stands in for the model.
 */

import type Anthropic from '@anthropic-ai/sdk'
import { AiError, setProviderForTests } from '@/lib/ai/llm'
import { chat, parseJsonObject } from '@/lib/ai/llm/chat'
import { embeddingAvailability } from '@/lib/ai/llm/embeddings'
import { messagesProvider } from '@/lib/ai/llm/providers/anthropic'
import { openaiProvider } from '@/lib/ai/llm/providers/openai'
import { scriptedMessage, scriptedProvider } from '@/lib/ai/llm/providers/scripted'
import { memorySpendLedger, setSpendLedgerForTests } from '@/lib/ai/llm/spend'

beforeEach(() => setSpendLedgerForTests(memorySpendLedger()))
afterEach(() => {
  setProviderForTests(null)
  setSpendLedgerForTests(null)
})

describe('chat messages on the gateway', () => {
  it('caches the first system line, sends later ones as context, and opens on the user', async () => {
    const provider = scriptedProvider([scriptedMessage({ text: 'ok' })])
    setProviderForTests(provider)
    await chat({
      purpose: 'insight.explain',
      messages: [
        { role: 'system', content: 'STABLE' },
        { role: 'assistant', content: 'an assistant line before any user line' },
        { role: 'user', content: 'question' },
        { role: 'system', content: 'LATER' },
      ],
    })
    const sent = provider.calls[0].params
    expect(sent.system).toEqual([
      { type: 'text', text: 'STABLE', cache_control: { type: 'ephemeral' } },
      { type: 'text', text: 'LATER' },
    ])
    expect(sent.messages).toEqual([{ role: 'user', content: 'question' }])
  })

  it('sends a prompt written only as system lines with its last line as the request', async () => {
    const provider = scriptedProvider([scriptedMessage({ text: 'ok' })])
    setProviderForTests(provider)
    await chat({ purpose: 'insight.explain', messages: [{ role: 'system', content: 'RULES' }, { role: 'system', content: 'DO IT' }] })
    expect(provider.calls[0].params.system).toEqual([{ type: 'text', text: 'RULES', cache_control: { type: 'ephemeral' } }])
    expect(provider.calls[0].params.messages).toEqual([{ role: 'user', content: 'DO IT' }])
  })

  it('reads a JSON answer from a fence or from prose, and hands back the bare JSON', async () => {
    setProviderForTests(scriptedProvider([scriptedMessage({ text: 'Here it is:\n```json\n{"a": 1}\n```' })]))
    const r = await chat({ purpose: 'build.plan', messages: [{ role: 'user', content: 'x' }], json: true })
    expect(r.json).toEqual({ a: 1 })
    expect(JSON.parse(r.text)).toEqual({ a: 1 })
    expect(parseJsonObject('noise {"b": [1, 2]} trailing')).toEqual({ b: [1, 2] })
  })

  it('calls an answer with no JSON in it invalid, and keeps the run it cost', async () => {
    setProviderForTests(scriptedProvider([scriptedMessage({ text: 'I cannot do that in JSON.' })]))
    const e = await chat({ purpose: 'build.plan', messages: [{ role: 'user', content: 'x' }], json: true }).catch((x) => x)
    expect(e).toBeInstanceOf(AiError)
    expect(e).toMatchObject({ kind: 'output_invalid', consumption: 'ran' })
    expect(e.usage.outputTokens).toBe(5)
  })
})

describe('text streamed as it is written', () => {
  it('passes Claude stream text to the caller and still returns the whole message', async () => {
    const final = scriptedMessage({ text: 'Hello world' })
    const listeners: Array<(d: string) => void> = []
    const api = {
      create: async () => final,
      stream: () => ({
        on: (_event: 'text', l: (d: string) => void) => listeners.push(l),
        finalMessage: async () => {
          for (const l of listeners) {
            l('Hello ')
            l('world')
          }
          return final
        },
      }),
    }
    const got: string[] = []
    const message = await messagesProvider('anthropic', api).send({ model: 'm', max_tokens: 10, messages: [] }, {
      timeoutMs: 1000,
      stream: false,
      onText: (d) => got.push(d),
    })
    expect(got).toEqual(['Hello ', 'world'])
    expect(message).toBe(final)
  })

  it('delivers the whole OpenAI answer once, since that adapter does not stream', async () => {
    const client = {
      chat: {
        completions: {
          create: async () => ({
            id: 'c1',
            model: 'gpt-4o-mini',
            choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'All of it' } }],
            usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
          }),
        },
      },
    } as unknown as Parameters<typeof openaiProvider>[1]
    const got: string[] = []
    await openaiProvider('k', client).send({ model: 'gpt-4o-mini', max_tokens: 10, messages: [{ role: 'user', content: 'x' }] } as Anthropic.MessageCreateParamsNonStreaming, {
      timeoutMs: 1000,
      stream: false,
      onText: (d) => got.push(d),
    })
    expect(got).toEqual(['All of it'])
  })
})

describe('embeddings', () => {
  it('say plainly when no embedding model is configured', () => {
    expect(embeddingAvailability({})).toEqual({ available: false, reason: expect.stringMatching(/OPENAI_API_KEY/) })
    expect(embeddingAvailability({ OPENAI_API_KEY: 'k' })).toEqual({ available: true })
    // A Claude provider alone does not make vector search available.
    expect(embeddingAvailability({ AI_PROVIDER: 'bedrock', BEDROCK_REGION: 'ap-south-1' })).toMatchObject({ available: false })
  })
})
