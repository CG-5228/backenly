/**
 * Claude, through the Claude API or Amazon Bedrock. Both clients expose the
 * same Messages API, so one implementation serves both.
 *
 * Bedrock uses the AWS credential provider chain: on ECS that is the task
 * role, so no key is stored anywhere. The region is explicit because the
 * Bedrock client otherwise falls back to us-east-1.
 */

import Anthropic from '@anthropic-ai/sdk'
import { AnthropicBedrock } from '@anthropic-ai/bedrock-sdk'
import type { LlmProvider } from '../types'

type Options = { timeout?: number; maxRetries?: number; signal?: AbortSignal }

interface MessageStream {
  on(event: 'text', listener: (delta: string) => void): unknown
  finalMessage(): Promise<Anthropic.Message>
}

interface MessagesApi {
  create(body: Anthropic.MessageCreateParamsNonStreaming, options?: Options): PromiseLike<Anthropic.Message>
  stream(body: Anthropic.MessageStreamParams, options?: Options): MessageStream
}

export function messagesProvider(id: 'anthropic' | 'bedrock', messages: MessagesApi): LlmProvider {
  return {
    id,
    async send(params, { timeoutMs, signal, stream, onText }) {
      // Retries are the gateway's: it knows whether a failure could have run
      // inference, and the SDK's own retries would hide a second billed run.
      const options: Options = { timeout: timeoutMs, maxRetries: 0, ...(signal ? { signal } : {}) }
      if (stream || onText) {
        const s = messages.stream(params as Anthropic.MessageStreamParams, options)
        if (onText) s.on('text', onText)
        return s.finalMessage()
      }
      return messages.create(params, options)
    },
  }
}

export function anthropicProvider(apiKey: string): LlmProvider {
  return messagesProvider('anthropic', new Anthropic({ apiKey, maxRetries: 0 }).messages)
}

export function bedrockProvider(region: string): LlmProvider {
  return messagesProvider('bedrock', new AnthropicBedrock({ awsRegion: region, maxRetries: 0 }).messages)
}
