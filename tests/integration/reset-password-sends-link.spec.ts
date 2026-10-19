/**
 * RESET_PASSWORD sends the account owner a reset link and returns no
 * credential to whoever invoked it.
 *
 * Real database throughout: the end-user row whose password must not change,
 * and the reset token the flow issues.
 * The test environment has no SMTP, so the send itself fails, which is also
 * the case worth proving: the tool says so, and still changes nothing.
 */
import crypto from 'crypto'
import { prisma } from '@/lib/db/prisma'
import { executeAction } from '@/lib/ai/minimal-executor'

let ownerId: string
let projectId: string
let schema: string
const endUserEmail = `end-user-${crypto.randomBytes(4).toString('hex')}@example.test`
const PASSWORD_BEFORE = 'scrypt$not-a-real-hash$before'

async function storedPassword(): Promise<string | null> {
  const rows = await prisma.$queryRawUnsafe<Array<{ password: string | null }>>(
    `SELECT password FROM "${schema}"."users" WHERE email = $1`,
    endUserEmail,
  )
  return rows[0]?.password ?? null
}

beforeAll(async () => {
  ownerId = (await prisma.user.create({
    data: { email: `owner-${crypto.randomBytes(6).toString('hex')}@example.test`, password: 'not-a-real-hash', name: 'owner' },
  })).id
  projectId = (await prisma.project.create({ data: { name: 'reset-password-sends-link', userId: ownerId } })).id
  schema = `workspace_${projectId}`
  await prisma.$executeRawUnsafe(`CREATE SCHEMA IF NOT EXISTS "${schema}"`)
  await prisma.$executeRawUnsafe(
    `CREATE TABLE IF NOT EXISTS "${schema}"."users" (
       id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
       email text UNIQUE NOT NULL,
       password text
     )`,
  )
  await prisma.$executeRawUnsafe(
    `INSERT INTO "${schema}"."users" (email, password) VALUES ($1, $2)`,
    endUserEmail,
    PASSWORD_BEFORE,
  )
}, 60_000)

afterAll(async () => {
  await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {})
  await prisma.healthFinding.deleteMany({ where: { projectId } }).catch(() => {})
  await prisma.auditLog.deleteMany({ where: { projectId } }).catch(() => {})
  await prisma.project.deleteMany({ where: { userId: ownerId } }).catch(() => {})
  await prisma.user.delete({ where: { id: ownerId } }).catch(() => {})
}, 60_000)

describe('RESET_PASSWORD', () => {
  it('never changes the password and never returns a credential', async () => {
    const result = await executeAction(
      // `confirmed` as the MCP typed-tool route sends it; allowReplan=false so
      // a failure is reported as-is instead of being re-planned by a model.
      { action: 'RESET_PASSWORD', params: { email: endUserEmail, confirmed: true } } as any,
      projectId,
      undefined,
      0,
      undefined,
      false,
    )

    const serialized = JSON.stringify(result)
    expect(serialized).not.toMatch(/tempPassword/i)
    expect(serialized).not.toMatch(/temporary password/i)
    expect(await storedPassword()).toBe(PASSWORD_BEFORE)

    // The flow issued a single-use token for the account owner's link.
    const tokens = await prisma.$queryRawUnsafe<Array<{ n: number }>>(
      `SELECT count(*)::int AS n FROM "${schema}"."_password_resets" WHERE email = $1 AND used_at IS NULL`,
      endUserEmail,
    )
    expect(tokens[0].n).toBe(1)

    // No SMTP in the test environment: the tool must say the link was NOT
    // sent rather than claim success, and must say nothing was changed.
    expect(result.success).toBe(false)
    expect(result.message).toMatch(/Could not email a reset link/)
    expect(result.message).toMatch(/No password was changed/)
  }, 60_000)

  it('reports an unknown account plainly', async () => {
    const result = await executeAction(
      { action: 'RESET_PASSWORD', params: { email: 'nobody@example.test', confirmed: true } } as any,
      projectId,
      undefined,
      0,
      undefined,
      false,
    )
    expect(result.success).toBe(false)
    expect(result.message).toMatch(/not found/)
  }, 60_000)
})
