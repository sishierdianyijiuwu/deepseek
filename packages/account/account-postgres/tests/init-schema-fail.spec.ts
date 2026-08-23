import { describe, expect, it, vi } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import { Mailer, type MailMessage } from '@deepseek-ai/dsh-mailer'

vi.mock('../src/schema.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/schema.ts')>()
  return {
    ...actual,
    ensureSchema: async () => {
      throw new Error('schema boom')
    },
  }
})

const { default: PostgresAccounts } = await import('../src/index.ts')

class SilentMailer extends Mailer {
  override async send(_message: MailMessage): Promise<void> {}
}

describe('postgres init', () => {
  it('closes the SQL client when schema setup fails', async () => {
    const ctx = new Context()
    await ctx.plugin(SilentMailer).await()
    const accounts = new PostgresAccounts(ctx, { url: 'pglite:', publicBaseUrl: 'http://127.0.0.1' })
    await expect(accounts[Service.init]()).rejects.toThrow('schema boom')
  })
})
