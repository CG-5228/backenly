/**
 * A provider that answers from a script, for tests and the lab's scripted arm.
 * It records every request it receives, so a test can assert what was sent as
 * well as what came back. Never selected by configuration.
 */

import type Anthropic from '@anthropic-ai/sdk'
import type { LlmProvider, SendOptions } from '../types'

export type ScriptStep =
  | Anthropic.Message
  | Error
  | ((params: Anthropic.MessageCreateParamsNonStreaming, opts: SendOptions) => Anthropic.Message | Promise<Anthropic.Message>)

export interface ScriptedProvider extends LlmProvider {
  calls: Array<{ params: Anthropic.MessageCreateParamsNonStreaming; opts: SendOptions }>
}

export function scriptedProvider(steps: ScriptStep[]): ScriptedProvider {
  const queue = [...steps]
  const calls: ScriptedProvider['calls'] = []
  return {
    id: 'scripted',
    calls,
    async send(params, opts) {
      calls.push({ params, opts })
      const step = queue.shift()
      if (step === undefined) throw new Error('scripted provider: no response left in the script')
      if (step instanceof Error) throw step
      return typeof step === 'function' ? step(params, opts) : step
    },
  }
}

/** A complete assistant message, with the fields a test usually sets. */
export function scriptedMessage(m: {
  /** A thinking block before everything else, as adaptive thinking produces. */
  thinking?: string
  text?: string
  toolUse?: Array<{ id?: string; name: string; input: Record<string, unknown> }>
  stopReason?: Anthropic.StopReason
  model?: string
  usage?: Partial<{ input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number }>
}): Anthropic.Message {
  const content: unknown[] = []
  if (m.thinking !== undefined) content.push({ type: 'thinking', thinking: m.thinking, signature: 'sig_scripted' })
  if (m.text !== undefined) content.push({ type: 'text', text: m.text, citations: null })
  for (const [i, t] of (m.toolUse ?? []).entries()) {
    content.push({ type: 'tool_use', id: t.id ?? `toolu_${i}`, name: t.name, input: t.input })
  }
  return {
    id: 'msg_scripted',
    type: 'message',
    role: 'assistant',
    model: m.model ?? 'claude-opus-4-6',
    content,
    stop_reason: m.stopReason ?? (m.toolUse?.length ? 'tool_use' : 'end_turn'),
    stop_sequence: null,
    usage: {
      input_tokens: m.usage?.input_tokens ?? 10,
      output_tokens: m.usage?.output_tokens ?? 5,
      cache_read_input_tokens: m.usage?.cache_read_input_tokens ?? 0,
      cache_creation_input_tokens: m.usage?.cache_creation_input_tokens ?? 0,
      cache_creation: null,
    },
  } as unknown as Anthropic.Message
}
