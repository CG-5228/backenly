/**
 * Vector search says what is true: it refuses where nothing can embed, refuses
 * to compare vectors from two different models, and no surface claims rows are
 * embedded when they are written, because nothing does that.
 */

import fs from 'fs'
import path from 'path'
import { EMBEDDING_DIMENSIONS, EMBEDDING_MODEL, vectorConfigMismatch } from '@/lib/ai/embeddings'

const ROOT = path.resolve(__dirname, '..', '..')
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8')
const ROUTE = 'app/api/v1/[projectId]/db/[tableName]/vector-search/route.ts'

describe('the stored vectors and the deployment’s model must match', () => {
  it('matches the model in use', () => {
    expect(vectorConfigMismatch({ model: EMBEDDING_MODEL, dimensions: EMBEDDING_DIMENSIONS })).toBeNull()
  })

  it('treats a table enabled before the model was recorded as the original model', () => {
    expect(vectorConfigMismatch({})).toBeNull()
  })

  it.each([
    { model: 'amazon.titan-embed-text-v2:0', dimensions: 1024 },
    { model: EMBEDDING_MODEL, dimensions: 512 },
  ])('refuses %o, naming both models', (recorded) => {
    const why = vectorConfigMismatch(recorded)
    expect(why).toContain(recorded.model)
    expect(why).toContain(EMBEDDING_MODEL)
  })
})

describe('the search route', () => {
  const route = read(ROUTE)

  it('checks availability and the model before it embeds anything', () => {
    const embedAt = route.indexOf('await embedText(')
    expect(route.indexOf('embeddingAvailability()')).toBeGreaterThan(-1)
    expect(route.indexOf('embeddingAvailability()')).toBeLessThan(embedAt)
    expect(route.indexOf('vectorConfigMismatch(vs)')).toBeLessThan(embedAt)
  })
})

describe('enabling it', () => {
  const executor = read('lib/ai/minimal-executor.ts')
  const body = executor.slice(executor.indexOf('async function executeEnableVectorSearch('))

  it('is refused before any DDL where no embedding model is configured', () => {
    expect(body.indexOf('embeddingAvailability()')).toBeGreaterThan(-1)
    expect(body.indexOf('embeddingAvailability()')).toBeLessThan(body.indexOf('CREATE EXTENSION'))
  })
})

describe('no surface claims rows are embedded on write', () => {
  it.each(['lib/ai/brain/tools.ts', 'lib/ai/brain/capabilities.ts', 'lib/ai/minimal-executor.ts', ROUTE])('%s', (rel) => {
    expect(read(rel)).not.toMatch(/auto-embed/i)
  })
})
