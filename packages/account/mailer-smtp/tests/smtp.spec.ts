import { createServer, type AddressInfo, type Socket } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import SmtpMailer, { sendSmtp } from '../src/index.ts'
import * as SmtpInvariant from '../src/invariant.ts'

const tlsState = vi.hoisted(() => ({ failUpgrade: false }))

vi.mock('node:tls', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:tls')>()
  const net = await import('node:net')
  return {
    ...actual,
    connect(options: { host?: string; port?: number; socket?: Socket }, callback?: () => void) {
      if (options.socket !== undefined) {
        const socket = options.socket
        process.nextTick(() => {
          if (tlsState.failUpgrade) {
            socket.emit('error', new Error('upgrade failed'))
            return
          }
          socket.emit('secureConnect')
          callback?.()
        })
        return socket
      }
      const port = options.port
      if (port === undefined) throw new Error('tls mock: port is required')
      const socket = net.connect({ host: options.host, port }, callback)
      socket.once('connect', () => {
        socket.emit('secureConnect')
      })
      return socket
    },
  }
})

let closeServer: (() => Promise<void>) | undefined

afterEach(async () => {
  tlsState.failUpgrade = false
  if (closeServer !== undefined) {
    try {
      await closeServer()
    } catch {
      // The previous test already closed the listener.
    }
  }
  closeServer = undefined
})

interface ListenOptions {
  greeting?: string
  advertiseStartTls?: boolean
  splitEhlo?: boolean
  hang?: boolean
  dropAfterConnect?: boolean
}

async function listenSmtp(options: ListenOptions = {}): Promise<number> {
  const greeting = options.greeting ?? '220 test\r\n'
  const advertiseStartTls = options.advertiseStartTls !== false
  const server = createServer((socket) => {
    if (options.hang === true) return
    socket.write(greeting)
    if (options.dropAfterConnect === true) {
      socket.destroy()
      return
    }
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
          const rest = advertiseStartTls
            ? '250-STARTTLS\r\n250 AUTH PLAIN\r\n'
            : '250 AUTH PLAIN\r\n'
          if (options.splitEhlo === true) {
            socket.write('250-hello\r\n')
            setTimeout(() => {
              socket.write(rest)
            }, 20)
          } else {
            socket.write(`250-hello\r\n${rest}`)
          }
        } else if (command === 'STARTTLS') {
          socket.write('220 ready\r\n')
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

const message = { to: 'person@example.com', subject: 'Hello', text: 'Body\n.hidden' }

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

  it('sends through STARTTLS and AUTH when EHLO is split across chunks', { timeout: 20_000 }, async () => {
    const port = await listenSmtp({ splitEhlo: true })
    const ctx = new Context()
    await ctx.plugin(SmtpMailer, {
      host: '127.0.0.1',
      port,
      secure: false,
      from: 'noreply@example.com',
      username: 'user',
      password: 'pass',
    }).await()
    await ctx.mailer.send(message)
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

  it('sends AUTH on cleartext when allowPlaintextAuth is set', { timeout: 20_000 }, async () => {
    const port = await listenSmtp({ advertiseStartTls: false })
    await sendSmtp({
      host: '127.0.0.1',
      port,
      secure: false,
      from: 'noreply@example.com',
      username: 'user',
      password: 'pass',
      allowPlaintextAuth: true,
      timeoutMs: 5_000,
    }, { to: 'a@b.c', subject: 's', text: 't' })
  })

  it('refuses AUTH on a non-TLS socket without allowPlaintextAuth', { timeout: 20_000 }, async () => {
    const port = await listenSmtp({ advertiseStartTls: false })
    await expect(sendSmtp({
      host: '127.0.0.1',
      port,
      secure: false,
      from: 'noreply@example.com',
      username: 'user',
      password: 'pass',
      allowPlaintextAuth: false,
      timeoutMs: 5_000,
    }, { to: 'a@b.c', subject: 's', text: 't' })).rejects.toThrow(/AUTH requires TLS/)
  })

  it('rejects a STARTTLS upgrade failure', { timeout: 20_000 }, async () => {
    tlsState.failUpgrade = true
    const port = await listenSmtp()
    await expect(sendSmtp({
      host: '127.0.0.1',
      port,
      secure: false,
      from: 'noreply@example.com',
      username: 'user',
      password: 'pass',
      allowPlaintextAuth: false,
      timeoutMs: 5_000,
    }, { to: 'a@b.c', subject: 's', text: 't' })).rejects.toThrow(/upgrade failed/)
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
      allowPlaintextAuth: false,
      timeoutMs: 5_000,
    }, { to: 'a@b.c', subject: 's', text: 't' })).rejects.toThrow(/expected 220/)
    await expect(sendSmtp({
      host: '127.0.0.1',
      port: 1,
      secure: false,
      from: 'noreply@example.com',
      username: undefined,
      password: undefined,
      allowPlaintextAuth: false,
      timeoutMs: 5_000,
    }, { to: 'a@b.c', subject: 's', text: 't' })).rejects.toThrow()
  })

  it('rejects a greeting that is not an SMTP reply', { timeout: 20_000 }, async () => {
    const port = await listenSmtp({ greeting: 'oops\r\n' })
    await expect(sendSmtp({
      host: '127.0.0.1',
      port,
      secure: false,
      from: 'noreply@example.com',
      username: undefined,
      password: undefined,
      allowPlaintextAuth: false,
      timeoutMs: 5_000,
    }, { to: 'a@b.c', subject: 's', text: 't' })).rejects.toThrow(/expected 220/)
  })

  it('times out when the server never replies', { timeout: 20_000 }, async () => {
    const port = await listenSmtp({ hang: true })
    await expect(sendSmtp({
      host: '127.0.0.1',
      port,
      secure: false,
      from: 'noreply@example.com',
      username: undefined,
      password: undefined,
      allowPlaintextAuth: false,
      timeoutMs: 80,
    }, { to: 'a@b.c', subject: 's', text: 't' })).rejects.toThrow(/timed out/)
  })

  it('rejects when the server closes after the greeting', { timeout: 20_000 }, async () => {
    const port = await listenSmtp({ dropAfterConnect: true })
    await expect(sendSmtp({
      host: '127.0.0.1',
      port,
      secure: false,
      from: 'noreply@example.com',
      username: undefined,
      password: undefined,
      allowPlaintextAuth: false,
      timeoutMs: 5_000,
    }, { to: 'a@b.c', subject: 's', text: 't' })).rejects.toThrow(/connection closed|ECONNRESET/)
  })
})

describe('invariant companion', () => {
  it('registers the package ownership with an empty installer', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry, { enabled: true })
    await expect(ctx.plugin(SmtpInvariant).await()).resolves.toBeDefined()
  })
})
