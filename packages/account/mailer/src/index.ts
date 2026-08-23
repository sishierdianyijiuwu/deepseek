/**
 * Service Definition for the mailer port (`ctx.mailer`). Transport is
 * configuration (SMTP or a test fake); Account vocabulary does not name SMTP.
 * @module @deepseek-ai/dsh-mailer
 */

import { Context, Service } from '@deepseek-ai/cordis'

/** One outbound message. */
export interface MailMessage {
  /** Recipient address. */
  to: string
  /** Subject line. */
  subject: string
  /** Plain-text body. */
  text: string
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    mailer: Mailer
  }
}

/**
 * Abstract mailer. Subclass and load the subclass as a plugin — it registers
 * as `ctx.mailer`.
 */
export abstract class Mailer extends Service {
  constructor(ctx: Context) {
    super(ctx, 'mailer')
  }

  /**
   * Deliver one message.
   * @param message - recipient, subject, and plain-text body.
   */
  abstract send(message: MailMessage): Promise<void>
}

export default Mailer
