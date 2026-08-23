/**
 * Shared ownership of one E2B sandbox. Capability adapters await the same SDK
 * handle, so filesystem and process operations inhabit one remote Linux world.
 * @module @deepseek-ai/dsh-e2b
 */

import { randomUUID } from 'node:crypto'
import { posix } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { AccountId } from '@deepseek-ai/dsh-account'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-agent'
import { FileType, Sandbox, SandboxNotFoundError } from 'e2b'

export {
  CommandExitError,
  FileNotFoundError,
  FileType,
  Sandbox,
  SandboxNotFoundError,
} from 'e2b'
export type { CommandHandle, CommandResult, EntryInfo } from 'e2b'

/**
 * Quote one opaque argument for the SDK's unavoidable `/bin/bash -l -c` layer.
 * @param value - Exact argument value to preserve.
 * @returns A single shell word with no interpolation.
 */
export function quoteE2BShellArg(value: string): string {
  return `'${value.replaceAll('\'', "'\"'\"'")}'`
}

/**
 * Isolate E2B's hard-coded login shell behind a fresh randomized home path.
 * @param overrides - Additional environment entries for the internal command.
 * @returns A fresh mutable map that the E2B SDK may extend.
 */
export function e2bControlEnvs(
  overrides: Readonly<Record<string, string>> = {},
): Record<string, string> {
  return { ...overrides, HOME: `/.dsh-e2b-control-${randomUUID()}` }
}

/** Configuration for the shared E2B sandbox owner. */
export interface Config {
  /** API key; omission reads `E2B_API_KEY`. It is never forwarded into the sandbox. */
  apiKey?: string
  /** Shared remote working directory, created before adapters receive the sandbox. */
  cwd?: string
  /** E2B sandbox lifetime in milliseconds; expiry always deletes the sandbox. */
  timeoutMs?: number
  /**
   * When true, sandboxes are created per Executing Session (one per Account)
   * rather than one eager process-wide sandbox. Hosted control plane sets this.
   */
  perExecutingSession?: boolean
}

interface ResolvedConfig {
  apiKey: string
  cwd: string
  timeoutMs: number
  perExecutingSession: boolean
}

interface SchemaResolvedConfig extends Config {
  cwd: string
  timeoutMs: number
  perExecutingSession: boolean
}

/** Another Executing Session already holds this Account's sandbox. */
export class ExecutingSessionBusyError extends Error {
  /**
   * @param sessionId - the Session that currently holds the lock.
   */
  constructor(readonly sessionId: SessionId) {
    super(`this Account already has Executing Session '${sessionId}'`)
    this.name = 'ExecutingSessionBusyError'
  }
}

interface ExecutingSlot {
  sessionId: SessionId
  sandbox: Promise<Sandbox>
  state: 'live' | 'stopping'
  stop: Promise<void>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    e2b: E2BRuntime
  }
}

/**
 * Creates one lazily consumable E2B SDK handle and deletes the sandbox at
 * timeout or disposal. Creation begins at plugin construction unless
 * `perExecutingSession` is set, in which case {@link startExecutingSession}
 * creates one sandbox per Account. Adapters await {@link getSandbox} before
 * their first operation. The platform API key is never installed in a sandbox.
 */
export class E2BRuntime extends Service {
  static Config: z<Config> = z.object({
    apiKey: z.string(),
    cwd: z.string().default('/home/user/workspace'),
    timeoutMs: z.number().default(300_000),
    perExecutingSession: z.boolean().default(false),
  })

  /** Validated remote working directory shared by provider adapters. */
  readonly cwd: string
  /** Remote directory reserved for adapter-owned process and terminal state. */
  readonly runtimeRoot: string
  /** Whether sandboxes are created per Executing Session instead of process-wide. */
  readonly perExecutingSession: boolean

  private readonly config: ResolvedConfig
  private readonly ready: Promise<Sandbox> | undefined
  private readonly slots = new Map<AccountId, ExecutingSlot>()
  private disposed = false

  constructor(ctx: Context, config: Config) {
    super(ctx, 'e2b')
    // Schemastery fills these fields before construction; the type does not encode that step.
    const resolved = config as SchemaResolvedConfig
    const apiKey = config.apiKey ?? process.env.E2B_API_KEY
    this.config = {
      apiKey: apiKey ?? '',
      cwd: resolved.cwd,
      timeoutMs: resolved.timeoutMs,
      perExecutingSession: resolved.perExecutingSession === true,
    }
    this.validate()
    this.cwd = this.config.cwd
    this.runtimeRoot = posix.join(this.cwd, '.dsh-e2b')
    this.perExecutingSession = this.config.perExecutingSession
    if (!this.perExecutingSession) {
      this.ready = this.open()
      // A deployment may load the owner before any adapter uses it. Keep a
      // failed eager connection observed; getSandbox() still returns the error.
      void this.ready.catch(() => {})
    }

    ctx.effect(() => async () => {
      this.disposed = true
      if (this.perExecutingSession) {
        await Promise.all([...this.slots.keys()].map(accountId => this.killSlot(accountId)))
        return
      }
      const ready = this.ready
      if (ready === undefined) return
      let sandbox: Sandbox
      try {
        sandbox = await ready
      } catch (_sandboxSetupFailure) {
        // open() either acquired no sandbox or already made the POC's one rollback attempt.
        return
      }
      try {
        await sandbox.kill()
      } catch (error: unknown) {
        if (!(error instanceof SandboxNotFoundError)) throw error
      }
    }, 'e2b sandbox teardown')
  }

  /**
   * Return the live SDK handle for this caller.
   * Process-wide mode returns the construction-time sandbox. Per-Executing-Session
   * mode returns the Account's sandbox from the initiating Agent.
   * @returns the created sandbox after the configured cwd exists.
   * @throws when E2B rejects creation, the service is disposing, or no Executing Session is active.
   */
  async getSandbox(): Promise<Sandbox> {
    if (this.disposed) throw new Error('E2B sandbox service is disposing')
    if (this.perExecutingSession) return this.sandboxForInitiator()
    const ready = this.ready
    if (ready === undefined) throw new Error('E2B sandbox service is disposing')
    const sandbox = await ready
    if (this.disposed) throw new Error('E2B sandbox service is disposing')
    return sandbox
  }

  /**
   * Create or reuse this Account's Executing Session sandbox.
   * @param accountId - owning Account.
   * @param sessionId - Session that holds the one-executing-session lock.
   * @returns the live sandbox after cwd setup.
   * @throws {@link ExecutingSessionBusyError} when another Session holds the lock.
   */
  async startExecutingSession(accountId: AccountId, sessionId: SessionId): Promise<Sandbox> {
    if (!this.perExecutingSession) return this.getSandbox()
    if (this.disposed) throw new Error('E2B sandbox service is disposing')
    for (;;) {
      const existing = this.slots.get(accountId)
      if (existing === undefined) break
      if (existing.state === 'stopping') {
        await existing.stop
        continue
      }
      if (existing.sessionId !== sessionId) throw new ExecutingSessionBusyError(existing.sessionId)
      const sandbox = await existing.sandbox
      if (this.disposed) throw new Error('E2B sandbox service is disposing')
      return sandbox
    }
    const sandbox = this.open()
    this.slots.set(accountId, {
      sessionId,
      sandbox,
      state: 'live',
      stop: Promise.resolve(),
    })
    try {
      const created = await sandbox
      if (this.disposed) {
        await this.killSandbox(created)
        throw new Error('E2B sandbox service is disposing')
      }
      return created
    } catch (error: unknown) {
      const slot = this.slots.get(accountId)
      if (slot?.sandbox === sandbox) this.slots.delete(accountId)
      throw error
    }
  }

  /**
   * Copy-back callers then kill this Account's sandbox. The durable Workspace
   * is not deleted. Missing or already-expired sandboxes are quiescence.
   * @param accountId - owning Account.
   * @param sessionId - Session that holds the lock; a mismatch is ignored.
   */
  async stopExecutingSession(accountId: AccountId, sessionId: SessionId): Promise<void> {
    const slot = this.slots.get(accountId)
    if (slot === undefined || slot.sessionId !== sessionId) return
    await this.killSlot(accountId)
  }

  /**
   * The Session that currently holds this Account's Executing Session lock.
   * @param accountId - owning Account.
   * @returns the locked Session id, or `undefined`.
   */
  executingSessionId(accountId: AccountId): SessionId | undefined {
    const slot = this.slots.get(accountId)
    return slot?.state === 'live' ? slot.sessionId : undefined
  }

  private async sandboxForInitiator(): Promise<Sandbox> {
    const agent = this.ctx.get('agents')?.currentInitiator()
    const owner = agent?.session.header.owner
    if (owner === undefined) {
      throw new Error('dsh-e2b: no Executing Session sandbox for this initiator')
    }
    const slot = this.slots.get(owner as AccountId)
    if (slot === undefined || slot.state !== 'live') {
      throw new Error('dsh-e2b: no Executing Session sandbox for this Account')
    }
    const sandbox = await slot.sandbox
    if (this.disposed) throw new Error('E2B sandbox service is disposing')
    return sandbox
  }

  private async killSlot(accountId: AccountId): Promise<void> {
    const slot = this.slots.get(accountId)
    if (slot === undefined) return
    if (slot.state === 'stopping') {
      await slot.stop
      return
    }
    slot.state = 'stopping'
    const stop = this.killSandboxPromise(slot.sandbox)
    slot.stop = stop
    try {
      await stop
    } finally {
      if (this.slots.get(accountId) === slot) this.slots.delete(accountId)
    }
  }

  private async killSandboxPromise(ready: Promise<Sandbox>): Promise<void> {
    let sandbox: Sandbox
    try {
      sandbox = await ready
    } catch (_sandboxSetupFailure) {
      return
    }
    await this.killSandbox(sandbox)
  }

  private async killSandbox(sandbox: Sandbox): Promise<void> {
    try {
      await sandbox.kill()
    } catch (error: unknown) {
      if (!(error instanceof SandboxNotFoundError)) throw error
    }
  }

  private validate(): void {
    if (this.config.apiKey.length === 0) {
      throw new Error('dsh-e2b: configure apiKey or set E2B_API_KEY')
    }
    if (!posix.isAbsolute(this.config.cwd)) {
      throw new Error(`dsh-e2b: cwd must be an absolute Linux path: ${this.config.cwd}`)
    }
    if (!Number.isFinite(this.config.timeoutMs) || this.config.timeoutMs <= 0) {
      throw new Error('dsh-e2b: timeoutMs must be a positive finite number')
    }
  }

  private async open(): Promise<Sandbox> {
    const sandbox = await Sandbox.create({
      apiKey: this.config.apiKey,
      timeoutMs: this.config.timeoutMs,
      secure: true,
      lifecycle: { onTimeout: 'kill' },
    })
    try {
      await sandbox.files.makeDir(this.cwd)
      await sandbox.files.makeDir(this.runtimeRoot)
      const runtimeRoot = await sandbox.files.getInfo(this.runtimeRoot)
      if (runtimeRoot.type !== FileType.DIR || runtimeRoot.symlinkTarget !== undefined) {
        throw new Error(`dsh-e2b: runtime root must be a real directory: ${this.runtimeRoot}`)
      }
      await sandbox.commands.run(
        `chmod 700 -- ${quoteE2BShellArg(this.runtimeRoot)}`,
        { envs: e2bControlEnvs() },
      )
      return sandbox
    } catch (error: unknown) {
      try {
        await sandbox.kill()
      } catch (_sandboxSetupRollbackFailure) {
        // TODO(e2b-setup-rollback): Add retry state only if a real double failure
        // outlives E2B's configured sandbox timeout.
      }
      throw error
    }
  }
}

export default E2BRuntime
