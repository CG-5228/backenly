/**
 * What each Claude model accepts, so the gateway never sends a request a model
 * rejects. Bedrock ids (`global.anthropic.claude-opus-4-6-v1`) and first-party
 * ids (`claude-opus-4-6`) name the same model and share one entry.
 */

import type { Effort } from './types'

export interface ModelCaps {
  efforts: readonly Effort[]
  /** Shortest prefix the model will cache. Shorter ones are silently not cached. */
  cacheMinTokens: number
  adaptiveThinking: boolean
}

const CAPS: Record<string, ModelCaps> = {
  // low | medium | high | max; `xhigh` arrived with Opus 4.7. Caching needs a
  // 4,096-token prefix on this model, not the 1,024 or 512 of others.
  'claude-opus-4-6': { efforts: ['low', 'medium', 'high', 'max'], cacheMinTokens: 4096, adaptiveThinking: true },
}

/**
 * A model not listed above is assumed to accept what Opus 4.6 accepts. A
 * request it rejects fails with a clear invalid_request, not silently.
 */
const ASSUMED: ModelCaps = CAPS['claude-opus-4-6']

/** Strip a Bedrock profile prefix (`global.`, `us.`), the `anthropic.` provider prefix and a `-v1` version. */
export function canonicalModel(id: string): string {
  return id
    .replace(/^(global|us|eu|apac|jp|au)\./, '')
    .replace(/^anthropic\./, '')
    .replace(/-v\d+(:\d+)?$/, '')
}

export function isClaudeModel(id: string): boolean {
  return canonicalModel(id).startsWith('claude-')
}

export function capsFor(id: string): ModelCaps {
  return CAPS[canonicalModel(id)] ?? ASSUMED
}

/** The highest effort at or below `wanted` that the model accepts. */
export function clampEffort(wanted: Effort, caps: ModelCaps): Effort {
  const order: Effort[] = ['low', 'medium', 'high', 'max']
  for (let i = order.indexOf(wanted); i >= 0; i--) {
    if (caps.efforts.includes(order[i])) return order[i]
  }
  return caps.efforts[0]
}
