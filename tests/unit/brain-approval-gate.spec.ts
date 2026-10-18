/**
 * The brain's approval gate is `needsApproval`, the same rule the MCP tool
 * route applies: the brain's destructive set OR an executor rated high-risk,
 * so backend_chat and the typed tool route always agree on what needs a person.
 */
import fs from 'fs'
import path from 'path'
import { needsApproval } from '@/lib/mcp/domains'
import { agentSystemPrompt } from '@/lib/ai/brain/prompts'

describe('the brain approval gate', () => {
  it.each([
    'drop_table',
    'truncate_table',
    'drop_column',
    'delete_bucket',
    'delete_file',
    'revoke_api_key',
    'rotate_api_key',
    'delete_env_var',
    'rollback_deploy',
    'trigger_deploy',
    'disable_realtime',
  ])('%s waits for a human', (tool) => {
    expect(needsApproval(tool)).toBe(true)
  })

  it('also stops high-risk executors the destructive set does not list', () => {
    expect(needsApproval('disconnect_frontend')).toBe(true)
  })

  it.each(['create_table', 'read_backend_state', 'reset_end_user_password'])(
    '%s runs without approval',
    (tool) => {
      expect(needsApproval(tool)).toBe(false)
    },
  )
})

// ── Structural pins ─────────────────────────────────────────────────────────
//
// These read the source, because the property they protect is an absence:
// there must be NO way for a message to stand in for a person. A type-level
// pin would not run here (jest compiles with SWC, and tsc excludes tests/), so
// it would look like a guard while checking nothing.
const root = path.resolve(__dirname, '..', '..')
const read = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf8')

describe('no confirmation by message', () => {
  it('gives the brain no input that pre-authorises destructive work', () => {
    const agent = read('lib/ai/brain/agent.ts')
    const start = agent.indexOf('export interface BrainInput {')
    expect(start).toBeGreaterThan(-1)
    const body = agent.slice(start, agent.indexOf('\n}\n', start))
    expect(body).not.toMatch(/^\s*destructiveConfirmed\??\s*:/m)
  })

  it('keeps no store that a later message could release', () => {
    expect(fs.existsSync(path.join(root, 'lib/ai/brain/pending-destructive.ts'))).toBe(false)
    expect(read('lib/ai/brain/agent.ts')).not.toMatch(/isDestructiveConfirmation|loadPendingDestructive/)
  })

  it('approves by running the recorded call, never by replaying a message through the brain', () => {
    const approvals = read('lib/mcp/approvals.ts')
    expect(approvals).not.toMatch(/from '@\/lib\/ai\/brain\/agent'/)
    expect(approvals).not.toMatch(/runBrain\(/)
  })
})

// The model reads its instructions; the gate enforces the rule. When the two
// disagree the model tells the user to type "confirm", and the reply reaches
// nothing waiting.
describe('the agent prompt states the rule the gate enforces', () => {
  const prompt = agentSystemPrompt()

  it('never says a message approves a gated call', () => {
    expect(prompt).not.toMatch(/LATEST user message/)
    expect(prompt).not.toMatch(/after the user types (DEPLOY|ROLLBACK)/i)
    expect(prompt).not.toMatch(/only call resolve_finding again once they confirm/)
    expect(prompt).toMatch(/Nothing typed in chat approves one/)
  })

  it('gives as examples only tools the gate really stops', () => {
    const examples = prompt.match(/HUMAN APPROVAL[\s\S]*?For example: ([^.]+)\./)?.[1]
    const names = (examples ?? '').split(',').map((s) => s.trim()).filter(Boolean)
    expect(names.length).toBeGreaterThan(5)
    for (const name of names) expect({ name, gated: needsApproval(name) }).toEqual({ name, gated: true })
  })
})
