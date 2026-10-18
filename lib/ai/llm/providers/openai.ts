/**
 * OpenAI behind the gateway, for self-hosted installs that use it. Requests
 * arrive in the Anthropic Messages shape and are translated at this edge, and
 * the answer is translated back, so callers never see the difference.
 *
 * What does not translate is refused before sending rather than approximated:
 * server tools, documents and other block types OpenAI chat has no form for.
 * Thinking and effort are Claude settings and are dropped here.
 */

import OpenAI from 'openai'
import type Anthropic from '@anthropic-ai/sdk'
import { AiError } from '../errors'
import type { LlmProvider } from '../types'
import { normalizeUsage } from '../usage'

type ChatMessage = OpenAI.Chat.ChatCompletionMessageParam
type ChatPart = OpenAI.Chat.ChatCompletionContentPart

function unsupported(what: string): AiError {
  return new AiError('invalid_request', `The OpenAI provider cannot send ${what}.`, { provider: 'openai', consumption: 'none' })
}

function systemText(system: Anthropic.MessageCreateParams['system']): string | undefined {
  if (!system) return undefined
  if (typeof system === 'string') return system
  return system.map((b) => b.text).join('\n\n')
}

function toolResultText(content: Anthropic.ToolResultBlockParam['content']): string {
  if (content === undefined) return ''
  if (typeof content === 'string') return content
  return content.map((b) => (b.type === 'text' ? b.text : JSON.stringify(b))).join('\n')
}

function imagePart(block: Anthropic.ImageBlockParam): ChatPart {
  const src = block.source
  if (src.type === 'base64') return { type: 'image_url', image_url: { url: `data:${src.media_type};base64,${src.data}` } }
  if (src.type === 'url') return { type: 'image_url', image_url: { url: src.url } }
  throw unsupported(`an image of source type "${(src as { type: string }).type}"`)
}

function translateMessage(m: Anthropic.MessageParam): ChatMessage[] {
  if (typeof m.content === 'string') {
    return [m.role === 'user' ? { role: 'user', content: m.content } : { role: 'assistant', content: m.content }]
  }

  if (m.role === 'assistant') {
    const text: string[] = []
    const calls: OpenAI.Chat.ChatCompletionMessageToolCall[] = []
    for (const b of m.content) {
      if (b.type === 'text') text.push(b.text)
      else if (b.type === 'tool_use') {
        calls.push({ id: b.id, type: 'function', function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) } })
      } else if (b.type === 'thinking' || b.type === 'redacted_thinking') continue
      else throw unsupported(`an assistant "${b.type}" block`)
    }
    return [{ role: 'assistant', content: text.length ? text.join('') : null, ...(calls.length ? { tool_calls: calls } : {}) }]
  }

  // A user turn: tool results become `tool` messages, which must directly
  // follow the assistant turn that called them, then the rest of the turn.
  const toolMessages: ChatMessage[] = []
  const parts: ChatPart[] = []
  for (const b of m.content) {
    if (b.type === 'tool_result') {
      toolMessages.push({ role: 'tool', tool_call_id: b.tool_use_id, content: toolResultText(b.content) })
    } else if (b.type === 'text') parts.push({ type: 'text', text: b.text })
    else if (b.type === 'image') parts.push(imagePart(b))
    else throw unsupported(`a user "${b.type}" block`)
  }
  return parts.length ? [...toolMessages, { role: 'user', content: parts }] : toolMessages
}

export function toOpenAI(params: Anthropic.MessageCreateParamsNonStreaming): OpenAI.Chat.ChatCompletionCreateParamsNonStreaming {
  const messages: ChatMessage[] = []
  const system = systemText(params.system)
  if (system) messages.push({ role: 'system', content: system })
  for (const m of params.messages) messages.push(...translateMessage(m))

  const body: OpenAI.Chat.ChatCompletionCreateParamsNonStreaming = {
    model: params.model,
    max_tokens: params.max_tokens,
    messages,
  }

  if (params.tools?.length) {
    body.tools = params.tools.map((t) => {
      if (!('input_schema' in t)) throw unsupported(`the server tool "${'name' in t ? t.name : t.type}"`)
      return {
        type: 'function' as const,
        function: { name: t.name, ...(t.description ? { description: t.description } : {}), parameters: t.input_schema as Record<string, unknown> },
      }
    })
  }

  const choice = params.tool_choice
  if (choice) {
    if (choice.type === 'auto') body.tool_choice = 'auto'
    else if (choice.type === 'any') body.tool_choice = 'required'
    else if (choice.type === 'none') body.tool_choice = 'none'
    else if (choice.type === 'tool') body.tool_choice = { type: 'function', function: { name: choice.name } }
  }

  const format = params.output_config?.format
  if (format?.type === 'json_schema') {
    body.response_format = { type: 'json_schema', json_schema: { name: 'response', schema: format.schema, strict: false } }
  }
  return body
}

const STOP: Record<string, Anthropic.StopReason> = {
  stop: 'end_turn',
  tool_calls: 'tool_use',
  function_call: 'tool_use',
  length: 'max_tokens',
  content_filter: 'refusal',
}

export function fromOpenAI(completion: OpenAI.Chat.ChatCompletion): Anthropic.Message {
  const choice = completion.choices[0]
  const prompt = completion.usage?.prompt_tokens ?? 0
  const cached = Math.min(prompt, completion.usage?.prompt_tokens_details?.cached_tokens ?? 0)
  const usage = {
    input_tokens: prompt - cached,
    output_tokens: completion.usage?.completion_tokens ?? 0,
    cache_read_input_tokens: cached,
    cache_creation_input_tokens: 0,
    cache_creation: null,
  } as unknown as Anthropic.Usage

  const content: Anthropic.ContentBlock[] = []
  const text = choice?.message?.content
  if (text) content.push({ type: 'text', text, citations: null } as Anthropic.TextBlock)
  for (const call of choice?.message?.tool_calls ?? []) {
    let input: unknown
    try {
      input = call.function.arguments ? JSON.parse(call.function.arguments) : {}
    } catch {
      // It ran and its usage is known, so the run can still be settled.
      throw new AiError('output_invalid', `Tool "${call.function.name}" arguments were not valid JSON.`, {
        provider: 'openai',
        consumption: 'ran',
        usage: normalizeUsage(usage),
      })
    }
    content.push({ type: 'tool_use', id: call.id, name: call.function.name, input } as Anthropic.ToolUseBlock)
  }

  return {
    id: completion.id,
    type: 'message',
    role: 'assistant',
    model: completion.model,
    content,
    stop_reason: STOP[choice?.finish_reason ?? 'stop'] ?? 'end_turn',
    stop_sequence: null,
    usage,
  } as unknown as Anthropic.Message
}

export function openaiProvider(apiKey: string, client: Pick<OpenAI, 'chat'> = new OpenAI({ apiKey, maxRetries: 0 })): LlmProvider {
  return {
    id: 'openai',
    async send(params, { timeoutMs, signal, onText }) {
      const completion = await client.chat.completions.create(toOpenAI(params), {
        timeout: timeoutMs,
        maxRetries: 0,
        ...(signal ? { signal } : {}),
      })
      const message = fromOpenAI(completion)
      // Not streamed here: the whole text arrives once, when it is complete.
      if (onText) {
        const text = message.content.filter((b): b is Anthropic.TextBlock => b.type === 'text').map((b) => b.text).join('')
        if (text) onText(text)
      }
      return message
    },
  }
}
