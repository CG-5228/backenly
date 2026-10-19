/**
 * BRAIN ↔ MODEL
 * =============
 * The brain's side of the AI gateway (lib/ai/llm): its tool catalog in the
 * shape a model is offered it, the conversation a turn sends, and what a failed
 * model call means for the turn. Kept apart from the loop so the translation
 * can be tested without a model or a database.
 */

import type Anthropic from '@anthropic-ai/sdk'
import { AiError, type AiErrorKind } from '../llm'
import type { BrainFailureCode } from './agent'
import type { ConversationTurn } from './memory'
import type { BrainToolSchema } from './tools'

/** A catalog tool as a model is offered it. The catalog keeps its own shape; this is its only translation. */
export function toModelTool(t: BrainToolSchema): Anthropic.Tool {
  return {
    name: t.function.name,
    ...(t.function.description ? { description: t.function.description } : {}),
    input_schema: t.function.parameters,
  }
}

/**
 * The messages a turn sends: its recent history, then the user's message.
 *
 * A model conversation opens with a user turn and has no empty turns, and the
 * stored history promises neither: an eight-turn window can begin on an
 * assistant reply, and an interrupted save can leave a blank row. Leading
 * assistant turns are dropped (the rolled summary covers what came before the
 * window) and blank ones skipped, rather than inventing a user turn.
 */
export function conversationFor(recent: ConversationTurn[], message: string): Anthropic.MessageParam[] {
  const turns = recent.filter((t) => t.content.trim().length > 0)
  const start = turns.findIndex((t) => t.role === 'user')
  const kept = start === -1 ? [] : turns.slice(start)
  return [
    ...kept.map((t): Anthropic.MessageParam => ({ role: t.role, content: t.content })),
    { role: 'user', content: message },
  ]
}

/** What a failed model call means for the turn: a code for the caller and a reason for the person. */
export interface ModelFailure {
  code: BrainFailureCode
  /** Completes "…because ___" in the turn's summary. */
  reason: string
  /** Whether the same request, sent again shortly, could succeed. */
  retryable: boolean
}

/**
 * Failures no retry fixes: there is no provider to call, or nothing may be
 * spent. Distinct from a rate limit, which this brain used to report all of
 * them as.
 */
const UNAVAILABLE: Partial<Record<AiErrorKind, string>> = {
  not_configured: 'no AI provider is configured on this deployment',
  quota_exhausted: 'the AI provider account is out of quota or credit',
  access_denied: "the AI provider refused this deployment's credentials",
  spend_limit: 'this deployment has reached its monthly AI spending limit',
  spend_unavailable: 'AI spend could not be recorded, so no request was sent',
  credits_exhausted: 'this account has used its AI credits for the month',
}

export function modelFailureOf(err: unknown): ModelFailure {
  if (!(err instanceof AiError)) {
    return { code: 'MODEL_ERROR', reason: 'the AI model returned an error', retryable: true }
  }
  const unavailable = UNAVAILABLE[err.kind]
  if (unavailable) return { code: 'AI_UNAVAILABLE', reason: unavailable, retryable: false }
  switch (err.kind) {
    case 'rate_limited':
      return { code: 'RATE_LIMITED', reason: 'the AI provider rate-limited us', retryable: true }
    case 'timeout':
      return { code: 'MODEL_TIMEOUT', reason: 'the AI model timed out', retryable: true }
    case 'unavailable':
      return { code: 'MODEL_ERROR', reason: 'the AI provider was unavailable', retryable: true }
    case 'output_invalid':
      return { code: 'MODEL_ERROR', reason: "the AI model's answer was cut off or malformed", retryable: true }
    case 'refused':
      return { code: 'MODEL_ERROR', reason: 'the AI model declined this request', retryable: false }
    case 'invalid_request':
      return { code: 'MODEL_ERROR', reason: 'the AI provider rejected the request as invalid', retryable: false }
    case 'aborted':
      return { code: 'MODEL_ERROR', reason: 'the model call was cancelled', retryable: true }
    default:
      return { code: 'MODEL_ERROR', reason: 'the AI model returned an error', retryable: true }
  }
}

/** One tool's outcome, answered to the model. A refusal is an error result, so the model reads it as one. */
export function toolResultBlock(
  toolUseId: string,
  payload: Record<string, unknown>,
  isError: boolean,
): Anthropic.ToolResultBlockParam {
  return {
    type: 'tool_result',
    tool_use_id: toolUseId,
    content: JSON.stringify(payload),
    ...(isError ? { is_error: true } : {}),
  }
}

/** The text a model message carries, every text block joined. */
export function textOf(message: Anthropic.Message): string {
  return message.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('')
    .trim()
}

/** The tool calls a model message asks for, in order. */
export function toolUsesOf(message: Anthropic.Message): Anthropic.ToolUseBlock[] {
  return message.content.filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use')
}
