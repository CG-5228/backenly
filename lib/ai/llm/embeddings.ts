/**
 * Embeddings, the gateway's one call that is not a chat.
 *
 * OpenAI text-embedding-3-small only, for now. No Claude provider offers an
 * embedding model, and Backenly Cloud's Bedrock account has none enabled yet,
 * so a deployment without OPENAI_API_KEY reports vector search as unavailable
 * instead of failing deeper in.
 */

import OpenAI from 'openai'
import { AiError, classifyProviderError } from './errors'

export const EMBEDDING_MODEL = 'text-embedding-3-small'
export const EMBEDDING_DIMENSIONS = 1536
const TIMEOUT_MS = 60_000

let cached: { key: string; client: OpenAI } | null = null

function clientFor(key: string): OpenAI {
  if (cached?.key !== key) cached = { key, client: new OpenAI({ apiKey: key, maxRetries: 2 }) }
  return cached.client
}

/** Whether embeddings can be made here, and if not, why. Configuration only. */
export function embeddingAvailability(
  env: Record<string, string | undefined> = process.env,
): { available: true } | { available: false; reason: string } {
  return env.OPENAI_API_KEY?.trim()
    ? { available: true }
    : { available: false, reason: 'Vector search needs an embedding model, and none is configured: set OPENAI_API_KEY.' }
}

/** One vector per input, in input order. Inputs must be non-empty. */
export async function embed(inputs: string[]): Promise<number[][]> {
  const key = process.env.OPENAI_API_KEY?.trim()
  if (!key) {
    throw new AiError('not_configured', 'No embedding model is configured: set OPENAI_API_KEY.', { consumption: 'none' })
  }
  try {
    const resp = await clientFor(key).embeddings.create({ model: EMBEDDING_MODEL, input: inputs }, { timeout: TIMEOUT_MS })
    // Returned in input order.
    return resp.data.map((row) => row.embedding)
  } catch (err) {
    throw classifyProviderError(err, 'openai')
  }
}
