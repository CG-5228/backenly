/**
 * The older call shape, on the gateway: a list of chat messages whose system
 * lines may appear anywhere, and optionally a JSON object back.
 *
 * Many pipelines were written as `chat.completions.create({ messages, ... })`
 * with prompts that already say "return JSON". This keeps those prompts and
 * that message list as they are, and maps them onto the gateway's one request
 * shape: the first system message is the cached prompt, later ones are the
 * call's own context, and the conversation is the rest. New code with a known
 * output shape should call `generate` with a `jsonSchema` instead.
 */

import type Anthropic from '@anthropic-ai/sdk'
import { AiError } from './errors'
import { generate } from './index'
import type { AiPurpose, GenerateRequest, GenerateResult } from './types'

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface ChatRequest extends Omit<GenerateRequest, 'system' | 'context' | 'messages' | 'jsonSchema'> {
  purpose: AiPurpose
  messages: ChatMessage[]
  /** Parse the answer as a JSON object, as the prompt asks for. */
  json?: boolean
}

export interface ChatResult {
  /** The answer's text. With `json`, exactly the JSON object, so a caller that parses it itself still can. */
  text: string
  /** The parsed object, when `json` was asked for. */
  json?: unknown
  result: GenerateResult
}

/** A JSON object out of a model's text: as sent, inside a code fence, or between its outermost braces. */
export function parseJsonObject(text: string): unknown {
  const trimmed = text.trim()
  const candidates = [
    trimmed,
    trimmed.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim(),
    trimmed.slice(trimmed.indexOf('{'), trimmed.lastIndexOf('}') + 1),
  ]
  for (const c of candidates) {
    if (!c) continue
    try {
      return JSON.parse(c)
    } catch {
      /* try the next shape */
    }
  }
  return undefined
}

export async function chat(req: ChatRequest): Promise<ChatResult> {
  const { messages, json, ...rest } = req
  const systems = messages.filter((m) => m.role === 'system' && m.content.trim())
  const turns: Anthropic.MessageParam[] = []
  for (const m of messages) {
    if (m.role === 'system' || !m.content.trim()) continue
    // A conversation opens with the user; an assistant line before any user
    // line is context, not a turn.
    if (turns.length === 0 && m.role === 'assistant') continue
    turns.push({ role: m.role, content: m.content })
  }
  // A prompt written entirely as system lines: the last one is the request.
  const system = turns.length === 0 ? systems.slice(0, -1) : systems
  if (turns.length === 0 && systems.length > 0) turns.push({ role: 'user', content: systems[systems.length - 1].content })

  const result = await generate({
    ...rest,
    ...(system[0] ? { system: system[0].content } : {}),
    ...(system.length > 1 ? { context: system.slice(1).map((s) => s.content).join('\n\n') } : {}),
    messages: turns,
  })

  if (!json) return { text: result.text, result }
  const parsed = parseJsonObject(result.text)
  if (parsed === undefined || typeof parsed !== 'object' || parsed === null) {
    const e = new AiError('output_invalid', 'The answer was not a JSON object.', {
      provider: result.provider,
      consumption: 'ran',
      usage: result.usage,
    })
    e.model = result.model
    throw e
  }
  return { text: JSON.stringify(parsed), json: parsed, result }
}
