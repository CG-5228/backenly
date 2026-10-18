#!/usr/bin/env tsx
/**
 * One small request through the AI gateway, to prove a deployment's provider,
 * credentials, model access and cost accounting work end to end.
 *
 * It makes a real, billed call (a few hundred tokens), so it refuses to run
 * without --yes. It prints what answered and what it cost, never a credential.
 *
 *   npx tsx scripts/ai-gateway-smoke.ts --yes
 */

import { aiAvailability, generate, AiError } from '@/lib/ai/llm'

async function main() {
  if (!process.argv.includes('--yes')) {
    console.error('This sends one billed request to the configured AI provider. Re-run with --yes.')
    process.exit(2)
  }
  const availability = aiAvailability()
  if (!availability.available) {
    console.error(`Not configured: ${availability.reason}`)
    process.exit(1)
  }

  try {
    const r = await generate({
      purpose: 'brain.classify',
      system: 'Answer with exactly one word.',
      messages: [{ role: 'user', content: 'Reply with the word: ready' }],
      maxTokens: 16,
    })
    console.log(
      JSON.stringify(
        {
          provider: r.provider,
          model: r.model,
          answer: r.text.trim(),
          stopReason: r.message.stop_reason,
          usage: r.usage,
          costUsd: r.costUsd,
          attempts: r.attempts,
        },
        null,
        2,
      ),
    )
  } catch (err) {
    if (err instanceof AiError) {
      console.error(`${err.kind} (inference ${err.consumption}): ${err.userMessage}\n${err.message}`)
    } else {
      console.error(err)
    }
    process.exit(1)
  }
}

void main()
