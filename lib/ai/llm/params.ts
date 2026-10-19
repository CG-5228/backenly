/**
 * Build the one request shape every provider receives, enforcing what the
 * routed models require. A rule broken here would otherwise surface as a 400
 * from the provider, or as a silent cost.
 *
 *   - `max_tokens` is always set. Left unset, Bedrock reserves the model's full
 *     output allowance against the account's quota for every call.
 *   - No `temperature`, and no prefilled final assistant turn (Opus 4.6 rejects
 *     prefill with a 400; ask for JSON with `jsonSchema` instead).
 *   - One top-level `system`: the stable prompt, then the call's own context
 *     as a second, uncached block.
 *   - Prompt caching by explicit breakpoints on the stable system block, the
 *     last tool and, for a tool loop, the last message. Bedrock's integration
 *     for Opus 4.6 rejects top-level `cache_control`. A prefix shorter than the
 *     model's minimum (4,096 tokens on Opus 4.6) is simply not cached, at no
 *     cost, so marking is always safe. Three breakpoints at most; the API
 *     allows four.
 *   - Adaptive thinking and `effort` only where the model accepts them, and no
 *     thinking with a forced tool choice, which the API rejects.
 *   - No `eager_input_streaming`: Bedrock's Opus 4.6 deployment rejects it.
 */

import type Anthropic from '@anthropic-ai/sdk'
import { AiError } from './errors'
import { capsFor, clampEffort, isClaudeModel } from './models'
import type { GenerateRequest, PurposeRoute } from './types'

const EPHEMERAL = { type: 'ephemeral' as const }

/** Long outputs and thinking stream, so a slow answer cannot hit an HTTP timeout. */
export function shouldStream(route: PurposeRoute, maxTokens: number): boolean {
  return route.thinking || maxTokens > 4096
}

export function buildParams(route: PurposeRoute, req: GenerateRequest): Anthropic.MessageCreateParamsNonStreaming {
  if (req.messages.length === 0) {
    throw new AiError('invalid_request', 'A request needs at least one message.', { consumption: 'none' })
  }
  if (req.messages[0].role !== 'user') {
    throw new AiError('invalid_request', 'The first message must come from the user.', { consumption: 'none' })
  }
  if (req.messages[req.messages.length - 1].role === 'assistant') {
    throw new AiError(
      'invalid_request',
      'The last message is an assistant turn (a prefill). The routed models reject it; request JSON with jsonSchema instead.',
      { consumption: 'none' },
    )
  }

  const maxTokens = Math.max(1, Math.min(route.maxTokens, req.maxTokens ?? route.maxTokens))
  const params: Anthropic.MessageCreateParamsNonStreaming = {
    model: route.model,
    max_tokens: maxTokens,
    messages: req.cacheConversation ? withConversationBreakpoint(req.messages) : req.messages,
  }

  const system: Anthropic.TextBlockParam[] = []
  if (req.system) system.push({ type: 'text', text: req.system, cache_control: EPHEMERAL })
  if (req.context) system.push({ type: 'text', text: req.context })
  if (system.length > 0) params.system = system
  if (req.tools && req.tools.length > 0) {
    const last = req.tools.length - 1
    params.tools = req.tools.map((t, i) => (i === last ? { ...t, cache_control: EPHEMERAL } : t))
  }
  if (req.toolChoice) params.tool_choice = req.toolChoice

  if (isClaudeModel(route.model)) {
    const caps = capsFor(route.model)
    const forcedTool = req.toolChoice?.type === 'any' || req.toolChoice?.type === 'tool'
    if (route.thinking && caps.adaptiveThinking && !forcedTool) {
      params.thinking = { type: 'adaptive' }
    }
    params.output_config = {
      effort: clampEffort(route.effort, caps),
      ...(req.jsonSchema ? { format: { type: 'json_schema' as const, schema: req.jsonSchema } } : {}),
    }
  } else if (req.jsonSchema) {
    // Translated by the OpenAI adapter into its own response format.
    params.output_config = { format: { type: 'json_schema', schema: req.jsonSchema } }
  }

  return params
}

/**
 * The messages with a cache breakpoint on the last block of the last one. A
 * copy: the caller's transcript stays unmarked, so the next call moves the
 * breakpoint forward and still reads this call's entry (a marker is not part
 * of the cached bytes). The last message is a user turn (checked above), so
 * its last block is text, an image or a tool result, all of which take one.
 */
function withConversationBreakpoint(messages: Anthropic.MessageParam[]): Anthropic.MessageParam[] {
  const last = messages[messages.length - 1]
  const blocks: Anthropic.ContentBlockParam[] =
    typeof last.content === 'string' ? [{ type: 'text', text: last.content }] : last.content
  if (blocks.length === 0) return messages
  const marked = blocks.map((b, i) =>
    i === blocks.length - 1 ? ({ ...b, cache_control: EPHEMERAL } as Anthropic.ContentBlockParam) : b,
  )
  return [...messages.slice(0, -1), { ...last, content: marked }]
}
