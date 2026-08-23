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

/** Default I/O deadline for one SMTP send. */
export const DEFAULT_SMTP_TIMEOUT_MS = 15_000

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
  /** Allow AUTH PLAIN on a socket that is not TLS. Defaults to false. */
  allowPlaintextAuth?: boolean
  /** Deadline in milliseconds for one send, including connect. */
  timeoutMs?: number
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
    allowPlaintextAuth: z.boolean().default(false),
    timeoutMs: z.number().min(1).default(DEFAULT_SMTP_TIMEOUT_MS),
  })

  private readonly spec: SmtpSpec

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
      allowPlaintextAuth: config.allowPlaintextAuth === true,
      timeoutMs: config.timeoutMs ?? DEFAULT_SMTP_TIMEOUT_MS,
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
  allowPlaintextAuth: boolean
  timeoutMs: number
}

/**
 * Send one message over SMTP.
 * @param spec - resolved transport settings.
 * @param message - recipient, subject, and body.
 */
export async function sendSmtp(spec: SmtpSpec, message: MailMessage): Promise<void> {
  const { socket, session } = openSession(spec)
  const timer = setTimeout(() => {
    session.fail(new Error('mailer-smtp: timed out'))
  }, spec.timeoutMs)
  try {
    await session.greeting()
    let encrypted = spec.secure
    const ehlo = await session.command(`EHLO ${spec.host}`, 250)
    if (!encrypted && advertisesStartTls(ehlo)) {
      await session.command('STARTTLS', 220)
      await session.startTls(spec.host)
      await session.command(`EHLO ${spec.host}`, 250)
      encrypted = true
    }
    if (spec.username !== undefined && spec.password !== undefined) {
      if (!encrypted && !spec.allowPlaintextAuth) {
        throw new Error(
          'mailer-smtp: AUTH requires TLS (STARTTLS or secure: true); set allowPlaintextAuth to override',
        )
      }
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
    clearTimeout(timer)
    socket.destroy()
  }
}

function openSession(spec: SmtpSpec): { socket: Socket; session: SmtpSession } {
  const socket = spec.secure
    ? tlsConnect({ host: spec.host, port: spec.port, servername: spec.host })
    : tcpConnect({ host: spec.host, port: spec.port })
  return { socket, session: new SmtpSession(socket) }
}

function advertisesStartTls(reply: string): boolean {
  return /^250[\s-]STARTTLS\b/im.test(reply)
}

function upgradeTls(socket: Socket, host: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const tlsSocket = tlsConnect({ socket, host, servername: host })
    const onError = (error: Error): void => {
      reject(error)
    }
    tlsSocket.once('error', onError)
    tlsSocket.once('secureConnect', () => {
      tlsSocket.off('error', onError)
      resolve(tlsSocket)
    })
  })
}

/**
 * Return the slice through the first SMTP final-reply line (`XYZ `), or
 * `undefined` while the buffer still has only continuations (`XYZ-`).
 */
function takeCompleteReply(buffer: string): { reply: string; rest: string } | undefined {
  let offset = 0
  while (true) {
    const nl = buffer.indexOf('\r\n', offset)
    if (nl < 0) return undefined
    const line = buffer.slice(offset, nl)
    const terminal = /^\d{3} /.test(line) || !/^\d{3}-/.test(line)
    offset = nl + 2
    if (terminal) return { reply: buffer.slice(0, offset), rest: buffer.slice(offset) }
  }
}

class SmtpSession {
  private buffer = ''
  private waiter: { resolve: (reply: string) => void; reject: (error: Error) => void } | undefined
  private failure: Error | undefined
  private socket: Socket

  constructor(socket: Socket) {
    this.socket = socket
    this.bind()
  }

  /**
   * Reject the in-flight reply (if any) and destroy the socket.
   * @param error - timeout, I/O, or protocol failure.
   */
  fail(error: Error): void {
    if (this.failure !== undefined) return
    this.failure = error
    const waiter = this.waiter
    this.waiter = undefined
    waiter?.reject(error)
    this.socket.destroy()
  }

  /**
   * Wrap the current socket with TLS after a 220 STARTTLS reply.
   * @param host - SMTP hostname for SNI.
   */
  async startTls(host: string): Promise<void> {
    this.unbind()
    try {
      this.socket = await upgradeTls(this.socket, host)
    } catch (error) {
      this.fail(error as Error)
      throw error
    }
    this.buffer = ''
    this.bind()
  }

  /**
   * Wait for the server greeting.
   */
  greeting(): Promise<void> {
    return this.expect(220).then(() => undefined)
  }

  /**
   * Send one command and wait for a matching reply code.
   * @param line - SMTP command without CRLF, or a DATA payload ending in `.`.
   * @param code - expected numeric reply.
   * @returns the complete reply, including continuation lines.
   */
  async command(line: string, code: number): Promise<string> {
    /* v8 ignore next -- close can land between greeting and the next write */
    if (this.failure !== undefined) throw this.failure
    this.socket.write(`${line}\r\n`)
    return this.expect(code)
  }

  private expect(code: number): Promise<string> {
    return this.readReply().then((reply) => {
      const trimmed = reply.trim()
      const idx = trimmed.lastIndexOf('\r\n')
      const last = idx < 0 ? trimmed : trimmed.slice(idx + 2)
      if (!last.startsWith(`${String(code)} `)) {
        throw new Error(`mailer-smtp: expected ${String(code)}, got ${reply.trim()}`)
      }
      return reply
    })
  }

  private readReply(): Promise<string> {
    return new Promise((resolve, reject) => {
      /* v8 ignore next 3 -- close can land before the next waiter is armed */
      if (this.failure !== undefined) {
        reject(this.failure)
        return
      }
      this.waiter = { resolve, reject }
      this.flush()
    })
  }

  private onData = (chunk: Buffer): void => {
    this.buffer += chunk.toString('utf8')
    this.flush()
  }

  private onError = (error: Error): void => {
    this.fail(error)
  }

  private onClose = (): void => {
    this.fail(new Error('mailer-smtp: connection closed'))
  }

  private bind(): void {
    this.socket.on('data', this.onData)
    this.socket.on('error', this.onError)
    this.socket.on('close', this.onClose)
  }

  private unbind(): void {
    this.socket.off('data', this.onData)
    this.socket.off('error', this.onError)
    this.socket.off('close', this.onClose)
  }

  private flush(): void {
    /* v8 ignore next -- a data chunk can arrive before the next waiter is armed */
    if (this.waiter === undefined) return
    const taken = takeCompleteReply(this.buffer)
    if (taken === undefined) return
    this.buffer = taken.rest
    const waiter = this.waiter
    this.waiter = undefined
    waiter.resolve(taken.reply)
  }
}

export default SmtpMailer
