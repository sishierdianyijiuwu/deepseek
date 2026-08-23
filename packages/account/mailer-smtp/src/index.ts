/**
 * SMTP Service Provider for the mailer port.
 * @module @deepseek-ai/dsh-mailer-smtp
 */

import { connect as tcpConnect } from 'node:net'
import { connect as tlsConnect } from 'node:tls'
import type { Socket } from 'node:net'
import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { Mailer, type MailMessage } from '@deepseek-ai/dsh-mailer'

/** Plugin config: SMTP transport. Missing host or from fails at load. */
export interface Config {
  /** SMTP server hostname. */
  host: string
  /** SMTP port; defaults to 587. */
  port?: number
  /** Use TLS from the first byte (typically port 465). */
  secure?: boolean
  /** From address on every message. */
  from: string
  /** SMTP AUTH username, when the server requires it. */
  username?: string
  /** SMTP AUTH password, when the server requires it. */
  password?: string
}

/**
 * SMTP mailer (`ctx.mailer`).
 */
export class SmtpMailer extends Mailer {
  static Config: z<Config> = z.object({
    host: z.string().required(),
    port: z.natural().max(65535).default(587),
    secure: z.boolean().default(false),
    from: z.string().required(),
    username: z.string().default(''),
    password: z.string().default(''),
  })

  private readonly spec: {
    host: string
    port: number
    secure: boolean
    from: string
    username: string | undefined
    password: string | undefined
  }

  /**
   * @param ctx - Cordis context.
   * @param config - validated SMTP settings.
   */
  constructor(ctx: Context, config: Config) {
    super(ctx)
    const host = config.host
    const from = config.from
    if (host === '' || from === '') {
      throw new Error('mailer-smtp: host and from are required')
    }
    const username = config.username === undefined || config.username === '' ? undefined : config.username
    const password = config.password === undefined || config.password === '' ? undefined : config.password
    if ((username === undefined) !== (password === undefined)) {
      throw new Error('mailer-smtp: username and password must be set together')
    }
    this.spec = {
      host,
      port: config.port === undefined ? 587 : config.port,
      secure: config.secure === true,
      from,
      username,
      password,
    }
  }

  /**
   * Deliver one message through SMTP.
   * @param message - recipient, subject, and plain-text body.
   */
  override send(message: MailMessage): Promise<void> {
    return sendSmtp(this.spec, message)
  }
}

interface SmtpSpec {
  host: string
  port: number
  secure: boolean
  from: string
  username: string | undefined
  password: string | undefined
}

/**
 * Send one message over SMTP.
 * @param spec - resolved transport settings.
 * @param message - recipient, subject, and body.
 */
export async function sendSmtp(spec: SmtpSpec, message: MailMessage): Promise<void> {
  const socket = await openSocket(spec)
  try {
    const session = new SmtpSession(socket)
    await session.greeting()
    await session.command(`EHLO ${spec.host}`, 250)
    if (spec.username !== undefined && spec.password !== undefined) {
      const token = Buffer.from(`\0${spec.username}\0${spec.password}`).toString('base64')
      await session.command(`AUTH PLAIN ${token}`, 235)
    }
    await session.command(`MAIL FROM:<${spec.from}>`, 250)
    await session.command(`RCPT TO:<${message.to}>`, 250)
    await session.command('DATA', 354)
    const escaped = message.text.replace(/\r?\n\./g, '\r\n..')
    await session.command(
      `Subject: ${message.subject}\r\nFrom: ${spec.from}\r\nTo: ${message.to}\r\n\r\n${escaped}\r\n.`,
      250,
    )
    await session.command('QUIT', 221)
  } finally {
    socket.destroy()
  }
}

function openSocket(spec: SmtpSpec): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = spec.secure
      ? tlsConnect({ host: spec.host, port: spec.port })
      : tcpConnect({ host: spec.host, port: spec.port })
    const onError = (error: Error): void => {
      reject(error)
    }
    socket.once('error', onError)
    socket.once('connect', () => {
      socket.off('error', onError)
      resolve(socket)
    })
  })
}

class SmtpSession {
  private buffer = ''
  private waiter: ((line: string) => void) | undefined

  constructor(private readonly socket: Socket) {
    socket.on('data', (chunk: Buffer) => {
      this.buffer += chunk.toString('utf8')
      this.flush()
    })
  }

  /**
   * Wait for the server greeting.
   */
  greeting(): Promise<void> {
    return this.expect(220)
  }

  /**
   * Send one command and wait for a matching reply code.
   * @param line - SMTP command without CRLF, or a DATA payload ending in `.`.
   * @param code - expected numeric reply.
   */
  async command(line: string, code: number): Promise<void> {
    this.socket.write(`${line}\r\n`)
    await this.expect(code)
  }

  private expect(code: number): Promise<void> {
    return this.readReply().then((reply) => {
      if (!reply.startsWith(String(code))) {
        throw new Error(`mailer-smtp: expected ${String(code)}, got ${reply.trim()}`)
      }
    })
  }

  private readReply(): Promise<string> {
    return new Promise((resolve) => {
      this.waiter = resolve
      this.flush()
    })
  }

  private flush(): void {
    /* v8 ignore next -- a data chunk can arrive before the next waiter is armed */
    if (this.waiter === undefined) return
    const lines = this.buffer.split('\r\n')
    if (lines.length < 2) return
    const complete: string[] = []
    while (lines.length > 1) {
      const line = lines.shift() as string
      complete.push(line)
      if (/^\d{3} /.test(line)) break
    }
    this.buffer = lines.join('\r\n')
    const waiter = this.waiter
    this.waiter = undefined
    waiter(complete.join('\r\n'))
  }
}

export default SmtpMailer
