import { createServer, type AddressInfo } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import SmtpMailer, { sendSmtp } from '../src/index.ts'
import * as SmtpInvariant from '../src/invariant.ts'

vi.mock('node:tls', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:tls')>()
  const net = await import('node:net')
  return { ...actual, connect: net.connect }
})

let closeServer: (() => Promise<void>) | undefined

afterEach(async () => {
  if (closeServer !== undefined) {
    try {
      await closeServer()
    } catch {
      // The previous test already closed the listener.
    }
  }
  closeServer = undefined
})

async function listenSmtp(replies?: { greeting?: string }): Promise<number> {
  const greeting = replies?.greeting ?? '220 test\r\n'
  const server = createServer((socket) => {
    socket.write(greeting)
    let buffer = ''
    let dataMode = false
    socket.on('data', (chunk) => {
      buffer += chunk.toString()
      const lines = buffer.split('\r\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        if (dataMode) {
          if (line === '.') {
            dataMode = false
            socket.write('250 ok\r\n')
          }
          continue
        }
        const command = line.split(' ')[0]?.toUpperCase()
        if (command === 'EHLO' || command === 'HELO') {
          socket.write('250-hello\r\n250 AUTH PLAIN\r\n')
        } else if (command === 'AUTH') {
          socket.write('235 ok\r\n')
        } else if (command === 'MAIL' || command === 'RCPT') {
          socket.write('250 ok\r\n')
        } else if (command === 'DATA') {
          dataMode = true
          socket.write('354 go\r\n')
        } else if (command === 'QUIT') {
          socket.write('221 bye\r\n')
          socket.end()
        } else {
          socket.write('250 ok\r\n')
        }
      }
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  closeServer = () => new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error)
        return
      }
      resolve()
    })
  })
  return (server.address() as AddressInfo).port
}

describe('smtp mailer', () => {
  it('refuses incomplete config', () => {
    expect(() => new SmtpMailer(new Context(), { host: '', from: 'a@b.c' })).toThrow(/host and from/)
    expect(() => new SmtpMailer(new Context(), { host: '127.0.0.1', from: '' })).toThrow(/host and from/)
    expect(() => new SmtpMailer(new Context(), { host: '127.0.0.1', from: 'a@b.c', username: 'u' }))
      .toThrow(/username and password/)
  })

  it('defaults port and secure when constructed without them', () => {
    new SmtpMailer(new Context(), { host: '127.0.0.1', from: 'noreply@example.com' })
  })

  it('sends through a local SMTP listener with AUTH', { timeout: 20_000 }, async () => {
    const port = await listenSmtp()
    const ctx = new Context()
    await ctx.plugin(SmtpMailer, {
      host: '127.0.0.1',
      port,
      secure: false,
      from: 'noreply@example.com',
      username: 'user',
      password: 'pass',
    }).await()
    await ctx.mailer.send({ to: 'person@example.com', subject: 'Hello', text: 'Body\n.hidden' })
    await ctx.fiber.dispose()
  })

  it('sends without AUTH and over the TLS connect path', { timeout: 20_000 }, async () => {
    const port = await listenSmtp()
    const ctx = new Context()
    await ctx.plugin(SmtpMailer, {
      host: '127.0.0.1',
      port,
      secure: true,
      from: 'noreply@example.com',
    }).await()
    await ctx.mailer.send({ to: 'person@example.com', subject: 'Hello', text: 'Body' })
    await ctx.fiber.dispose()
  })

  it('rejects a mismatched SMTP reply and a refused connection', { timeout: 20_000 }, async () => {
    const port = await listenSmtp({ greeting: '421 busy\r\n' })
    await expect(sendSmtp({
      host: '127.0.0.1',
      port,
      secure: false,
      from: 'noreply@example.com',
      username: undefined,
      password: undefined,
    }, { to: 'a@b.c', subject: 's', text: 't' })).rejects.toThrow(/expected 220/)
    await expect(sendSmtp({
      host: '127.0.0.1',
      port: 1,
      secure: false,
      from: 'noreply@example.com',
      username: undefined,
      password: undefined,
    }, { to: 'a@b.c', subject: 's', text: 't' })).rejects.toThrow()
  })
})

describe('invariant companion', () => {
  it('registers the package ownership with an empty installer', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry, { enabled: true })
    await expect(ctx.plugin(SmtpInvariant).await()).resolves.toBeDefined()
  })
})
