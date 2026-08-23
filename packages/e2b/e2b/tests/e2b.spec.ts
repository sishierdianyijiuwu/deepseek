import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Mock } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Sandbox as SandboxType } from 'e2b'
import { accountId } from '@deepseek-ai/dsh-account'
import { SessionId } from '@deepseek-ai/dsh-session'
import E2BRuntime, {
  e2bControlEnvs,
  ExecutingSessionBusyError,
  FileType,
  SandboxNotFoundError,
  quoteE2BShellArg,
} from '@deepseek-ai/dsh-e2b'
import * as E2BInvariant from '../src/invariant.ts'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'

const sdk = vi.hoisted(() => ({
  create: vi.fn(),
}))

vi.mock('e2b', async (importOriginal) => {
  const actual = await importOriginal<typeof import('e2b')>()
  // The mock replaces only the SDK's static factory surface and is never constructed.
  // oxlint-disable-next-line typescript/no-extraneous-class -- The SDK contract is a class with a static factory.
  class FakeSandbox {
    static create(...args: unknown[]): unknown {
      return sdk.create(...args)
    }
  }
  return { ...actual, Sandbox: FakeSandbox }
})

interface SandboxFixture {
  sandbox: SandboxType
  makeDir: ReturnType<typeof vi.fn>
  getInfo: ReturnType<typeof vi.fn>
  run: Mock<RunCommand>
  kill: ReturnType<typeof vi.fn>
}

type RunCommand = (
  command: string,
  options?: { envs?: Record<string, string> },
) => Promise<{ exitCode: number; stdout: string; stderr: string }>

function fakeSandbox(id = 'sandbox-1'): SandboxFixture {
  const makeDir = vi.fn().mockResolvedValue(true)
  const getInfo = vi.fn().mockResolvedValue({ type: FileType.DIR })
  const run = vi.fn<RunCommand>().mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' })
  const kill = vi.fn().mockResolvedValue(undefined)
  const sandbox = {
    sandboxId: id,
    files: { makeDir, getInfo },
    commands: { run },
    kill,
  } as unknown as SandboxType
  return { sandbox, makeDir, getInfo, run, kill }
}

beforeEach(() => {
  sdk.create.mockReset()
  vi.unstubAllEnvs()
})

describe('E2BRuntime', () => {
  it('gives each SDK login shell a fresh non-overridable control home', () => {
    const first = e2bControlEnvs({ HOME: '/hostile', NPM_TOKEN: '' })
    const second = e2bControlEnvs()

    expect(first.HOME).toMatch(/^\/\.dsh-e2b-control-/)
    expect(first).toEqual({ HOME: first.HOME, NPM_TOKEN: '' })
    expect(first.HOME).not.toBe(second.HOME)
  })

  it('creates one protected shared sandbox and kills it on default disposal', async () => {
    const fixture = fakeSandbox()
    sdk.create.mockResolvedValue(fixture.sandbox)
    const ctx = new Context()
    const fiber = await ctx.plugin(E2BRuntime, { apiKey: 'test-key' })

    const service = ctx.e2b
    await expect(service.getSandbox()).resolves.toBe(fixture.sandbox)
    expect(service.cwd).toBe('/home/user/workspace')
    expect(service.runtimeRoot).toBe('/home/user/workspace/.dsh-e2b')
    expect(sdk.create).toHaveBeenCalledWith({
      apiKey: 'test-key',
      timeoutMs: 300_000,
      secure: true,
      lifecycle: { onTimeout: 'kill' },
    })
    expect(fixture.makeDir).toHaveBeenNthCalledWith(1, '/home/user/workspace')
    expect(fixture.makeDir).toHaveBeenNthCalledWith(2, '/home/user/workspace/.dsh-e2b')
    expect(fixture.getInfo).toHaveBeenCalledWith('/home/user/workspace/.dsh-e2b')
    const runOptions = fixture.run.mock.calls[0]?.[1]
    expect(runOptions?.envs?.HOME).toMatch(/^\/\.dsh-e2b-control-/)
    expect(fixture.run).toHaveBeenCalledWith(
      "chmod 700 -- '/home/user/workspace/.dsh-e2b'",
      { envs: { HOME: runOptions?.envs?.HOME } },
    )

    await fiber.dispose()
    expect(fixture.kill).toHaveBeenCalledOnce()
    await expect(service.getSandbox()).rejects.toThrow(/disposing/)
  })

  it('startExecutingSession in process-wide mode returns the shared sandbox', async () => {
    const fixture = fakeSandbox()
    sdk.create.mockResolvedValue(fixture.sandbox)
    const ctx = new Context()
    const fiber = await ctx.plugin(E2BRuntime, { apiKey: 'test-key' })
    const started = await ctx.e2b.startExecutingSession(accountId('a'), SessionId('s'))
    expect(started).toEqual({ sandbox: fixture.sandbox, reused: true })
    expect(ctx.e2b.perExecutingSession).toBe(false)
    expect(ctx.e2b.executingSessionId(accountId('a'))).toBeUndefined()
    await fiber.dispose()
  })

  it('rejects handle acquisition when disposal starts during setup', async () => {
    const fixture = fakeSandbox()
    const opening = Promise.withResolvers<SandboxType>()
    sdk.create.mockReturnValue(opening.promise)
    const ctx = new Context()
    const fiber = await ctx.plugin(E2BRuntime, { apiKey: 'test-key' })

    const acquisition = ctx.e2b.getSandbox()
    const disposing = fiber.dispose()
    opening.resolve(fixture.sandbox)

    await expect(acquisition).rejects.toThrow(/disposing/)
    await expect(disposing).resolves.toBeUndefined()
    expect(fixture.kill).toHaveBeenCalledOnce()
  })

  it('reads the key from the environment and honors the configured cwd and lifetime', async () => {
    vi.stubEnv('E2B_API_KEY', 'environment-key')
    const fixture = fakeSandbox('configured-sandbox')
    sdk.create.mockResolvedValue(fixture.sandbox)
    const ctx = new Context()
    const fiber = await ctx.plugin(E2BRuntime, {
      cwd: '/workspace/project',
      timeoutMs: 60_000,
    })
    await ctx.e2b.getSandbox()

    expect(sdk.create).toHaveBeenCalledWith({
      apiKey: 'environment-key',
      timeoutMs: 60_000,
      secure: true,
      lifecycle: { onTimeout: 'kill' },
    })
    expect(ctx.e2b.cwd).toBe('/workspace/project')
    await fiber.dispose()
    expect(fixture.kill).toHaveBeenCalledOnce()
  })

  it('accepts a missing sandbox when disposal itself requests deletion', async () => {
    const fixture = fakeSandbox()
    fixture.kill.mockRejectedValue(new SandboxNotFoundError('already deleted'))
    sdk.create.mockResolvedValue(fixture.sandbox)
    const ctx = new Context()
    const errors: unknown[] = []
    ctx.logger.error = ((error: unknown) => { errors.push(error) }) as typeof ctx.logger.error
    const fiber = await ctx.plugin(E2BRuntime, { apiKey: 'test-key' })
    await ctx.e2b.getSandbox()

    await fiber.dispose()
    expect(fixture.kill).toHaveBeenCalledOnce()
    expect(errors).toEqual([])
  })

  it('does not classify other disposal failures as an already-gone sandbox', async () => {
    const fixture = fakeSandbox()
    const failure = new Error('disposition unknown')
    fixture.kill.mockRejectedValue(failure)
    sdk.create.mockResolvedValue(fixture.sandbox)
    const ctx = new Context()
    const errors: unknown[] = []
    ctx.logger.error = ((error: unknown) => { errors.push(error) }) as typeof ctx.logger.error
    const fiber = await ctx.plugin(E2BRuntime, { apiKey: 'test-key' })
    await ctx.e2b.getSandbox()
    await expect(fiber.dispose()).resolves.toBeUndefined()
    expect(fixture.kill).toHaveBeenCalledOnce()
    expect(errors).toContain(failure)
  })

  it('kills a newly created sandbox when remote directory setup fails', async () => {
    const fixture = fakeSandbox()
    fixture.makeDir.mockRejectedValueOnce(new Error('setup failed'))
    sdk.create.mockResolvedValue(fixture.sandbox)
    const ctx = new Context()
    const fiber = await ctx.plugin(E2BRuntime, { apiKey: 'test-key' })

    await expect(ctx.e2b.getSandbox()).rejects.toThrow('setup failed')
    expect(fixture.kill).toHaveBeenCalledOnce()
    await fiber.dispose()
  })

  it('preserves the setup failure after its one rollback attempt fails', async () => {
    const fixture = fakeSandbox()
    fixture.run.mockRejectedValueOnce(new Error('chmod failed'))
    fixture.kill.mockRejectedValueOnce(new Error('cleanup failed'))
    sdk.create.mockResolvedValue(fixture.sandbox)
    const ctx = new Context()
    const fiber = await ctx.plugin(E2BRuntime, { apiKey: 'test-key' })
    await expect(ctx.e2b.getSandbox()).rejects.toThrow('chmod failed')
    expect(fixture.kill).toHaveBeenCalledOnce()

    await fiber.dispose()
    expect(fixture.kill).toHaveBeenCalledOnce()
  })

  it.each([
    ['symbolic link', { type: FileType.DIR, symlinkTarget: '/tmp/redirected' }],
    ['regular file', { type: FileType.FILE }],
  ])('rejects a reserved runtime root that is a %s', async (_label, info) => {
    const fixture = fakeSandbox()
    fixture.getInfo.mockResolvedValueOnce(info)
    sdk.create.mockResolvedValue(fixture.sandbox)
    const ctx = new Context()
    await ctx.plugin(E2BRuntime, { apiKey: 'test-key' })

    await expect(ctx.e2b.getSandbox()).rejects.toThrow('runtime root must be a real directory')
    expect(fixture.run).not.toHaveBeenCalled()
    expect(fixture.kill).toHaveBeenCalledOnce()
  })

  it.each([
    [{ apiKey: '' }, /configure apiKey/],
    [{ apiKey: 'x', cwd: 'relative' }, /absolute Linux path/],
    [{ apiKey: 'x', timeoutMs: 0 }, /positive finite/],
  ] as const)('fails self-contained configuration before opening E2B: %j', async (config, message) => {
    vi.stubEnv('E2B_API_KEY', '')
    const ctx = new Context()
    await expect(ctx.plugin(E2BRuntime, config)).rejects.toThrow(message)
    expect(sdk.create).not.toHaveBeenCalled()
  })

  it('does not install the platform key as a sandbox environment variable', async () => {
    const fixture = fakeSandbox()
    sdk.create.mockResolvedValue(fixture.sandbox)
    const ctx = new Context()
    const fiber = await ctx.plugin(E2BRuntime, { apiKey: 'platform-secret' })
    await ctx.e2b.getSandbox()
    expect(sdk.create).toHaveBeenCalledWith(expect.not.objectContaining({
      envs: expect.objectContaining({ E2B_API_KEY: 'platform-secret' }),
    }))
    const createArg = sdk.create.mock.calls[0]?.[0] as { apiKey?: string; envs?: Record<string, string> }
    expect(createArg.apiKey).toBe('platform-secret')
    expect(createArg.envs).toBeUndefined()
    await fiber.dispose()
  })

  it('creates one sandbox per Executing Session and refuses a second Session', async () => {
    const first = fakeSandbox('exec-1')
    const second = fakeSandbox('exec-2')
    sdk.create.mockResolvedValueOnce(first.sandbox).mockResolvedValueOnce(second.sandbox)
    const ctx = new Context()
    const account = accountId('account-a')
    const sessionA = SessionId('session-a')
    const sessionB = SessionId('session-b')
    ctx.provide('agents', {
      currentInitiator: () => ({ session: { header: { owner: account }, id: sessionA } }),
    } as never)
    const fiber = await ctx.plugin(E2BRuntime, { apiKey: 'test-key', perExecutingSession: true })
    expect(sdk.create).not.toHaveBeenCalled()

    const sandbox = await ctx.e2b.startExecutingSession(account, sessionA)
    expect(sandbox).toEqual({ sandbox: first.sandbox, reused: false })
    expect(ctx.e2b.executingSessionId(account)).toBe(sessionA)
    expect(ctx.e2b.executingSandbox(account)).toBe(first.sandbox)
    await expect(ctx.e2b.startExecutingSession(account, sessionA))
      .resolves.toEqual({ sandbox: first.sandbox, reused: true })
    await expect(ctx.e2b.getSandbox()).resolves.toBe(first.sandbox)
    await expect(ctx.e2b.startExecutingSession(account, sessionB))
      .rejects.toBeInstanceOf(ExecutingSessionBusyError)
    expect(sdk.create).toHaveBeenCalledOnce()
    expect(sdk.create.mock.calls[0]?.[0]).toEqual(expect.objectContaining({
      apiKey: 'test-key',
      lifecycle: { onTimeout: 'kill' },
    }))
    expect((sdk.create.mock.calls[0]?.[0] as { envs?: unknown }).envs).toBeUndefined()

    await ctx.e2b.stopExecutingSession(account, sessionA)
    expect(first.kill).toHaveBeenCalledOnce()
    expect(ctx.e2b.executingSessionId(account)).toBeUndefined()
    expect(ctx.e2b.executingSandbox(account)).toBeUndefined()
    await expect(ctx.e2b.getSandbox()).rejects.toThrow(/no Executing Session sandbox/)
    await expect(ctx.e2b.startExecutingSession(account, sessionB))
      .resolves.toEqual({ sandbox: second.sandbox, reused: false })
    await ctx.e2b.stopExecutingSession(account, SessionId('other'))
    expect(ctx.e2b.executingSessionId(account)).toBe(sessionB)
    await expect(ctx.e2b.getSandbox()).resolves.toBe(second.sandbox)
    await fiber.dispose()
    expect(second.kill).toHaveBeenCalledOnce()
  })

  it('routes getSandbox through the initiating Account and ignores a missing stop', async () => {
    const fixture = fakeSandbox()
    sdk.create.mockResolvedValue(fixture.sandbox)
    const ctx = new Context()
    const account = accountId('account-b')
    let initiator: { session: { header: { owner?: typeof account }; id: ReturnType<typeof SessionId> } } | undefined
    ctx.provide('agents', {
      currentInitiator: () => initiator,
    } as never)
    const fiber = await ctx.plugin(E2BRuntime, { apiKey: 'test-key', perExecutingSession: true })
    await expect(ctx.e2b.getSandbox()).rejects.toThrow(/no Executing Session sandbox/)
    await ctx.e2b.stopExecutingSession(account, SessionId('none'))
    const started = await ctx.e2b.startExecutingSession(account, SessionId('s1'))
    expect(started).toEqual({ sandbox: fixture.sandbox, reused: false })
    initiator = { session: { header: { owner: account }, id: SessionId('s1') } }
    await expect(ctx.e2b.getSandbox()).resolves.toBe(fixture.sandbox)
    initiator = { session: { header: {}, id: SessionId('s1') } }
    await expect(ctx.e2b.getSandbox()).rejects.toThrow(/no Executing Session sandbox/)
    await fiber.dispose()
  })

  it('waits for an in-flight stop before starting another Executing Session', async () => {
    const first = fakeSandbox('stop-1')
    const second = fakeSandbox('stop-2')
    sdk.create.mockResolvedValueOnce(first.sandbox).mockResolvedValueOnce(second.sandbox)
    const gate = Promise.withResolvers<undefined>()
    first.kill.mockReturnValue(gate.promise)
    const ctx = new Context()
    const account = accountId('account-c')
    const fiber = await ctx.plugin(E2BRuntime, { apiKey: 'test-key', perExecutingSession: true })
    await ctx.e2b.startExecutingSession(account, SessionId('s1'))
    const stopping = ctx.e2b.stopExecutingSession(account, SessionId('s1'))
    const starting = ctx.e2b.startExecutingSession(account, SessionId('s2'))
    gate.resolve(undefined)
    await stopping
    await expect(starting).resolves.toEqual({ sandbox: second.sandbox, reused: false })
    await fiber.dispose()
  })

  it('serializes two starts after stop so a second Session cannot open a second sandbox', async () => {
    const first = fakeSandbox('one')
    const second = fakeSandbox('two')
    const third = fakeSandbox('three')
    sdk.create
      .mockResolvedValueOnce(first.sandbox)
      .mockResolvedValueOnce(second.sandbox)
      .mockResolvedValueOnce(third.sandbox)
    const ctx = new Context()
    const account = accountId('account-serial')
    const fiber = await ctx.plugin(E2BRuntime, { apiKey: 'test-key', perExecutingSession: true })
    await ctx.e2b.startExecutingSession(account, SessionId('s1'))
    await ctx.e2b.stopExecutingSession(account, SessionId('s1'))
    const results = await Promise.allSettled([
      ctx.e2b.startExecutingSession(account, SessionId('s2')),
      ctx.e2b.startExecutingSession(account, SessionId('s3')),
    ])
    const fulfilled = results.filter(result => result.status === 'fulfilled')
    const rejected = results.filter(result => result.status === 'rejected')
    expect(fulfilled).toHaveLength(1)
    expect(rejected).toHaveLength(1)
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(ExecutingSessionBusyError)
    expect(sdk.create).toHaveBeenCalledTimes(2)
    await fiber.dispose()
  })

  it('does not keep an Executing Session slot when sandbox setup fails', async () => {
    const fixture = fakeSandbox()
    fixture.makeDir.mockRejectedValueOnce(new Error('setup failed'))
    sdk.create.mockResolvedValue(fixture.sandbox)
    const ctx = new Context()
    const account = accountId('account-d')
    const fiber = await ctx.plugin(E2BRuntime, { apiKey: 'test-key', perExecutingSession: true })
    await expect(ctx.e2b.startExecutingSession(account, SessionId('s1'))).rejects.toThrow('setup failed')
    expect(ctx.e2b.executingSessionId(account)).toBeUndefined()
    fixture.makeDir.mockResolvedValue(true)
    sdk.create.mockResolvedValue(fakeSandbox('retry').sandbox)
    await expect(ctx.e2b.startExecutingSession(account, SessionId('s1'))).resolves.toBeDefined()
    await fiber.dispose()
  })

  it('refuses Executing Session start after disposal', async () => {
    const fixture = fakeSandbox()
    sdk.create.mockResolvedValue(fixture.sandbox)
    const ctx = new Context()
    const fiber = await ctx.plugin(E2BRuntime, { apiKey: 'test-key', perExecutingSession: true })
    const service = ctx.e2b
    await fiber.dispose()
    await expect(service.startExecutingSession(accountId('a'), SessionId('s')))
      .rejects.toThrow(/disposing/)
    await expect(service.getSandbox()).rejects.toThrow(/disposing/)
  })

  it('requires a key when both config and the environment omit it', async () => {
    const original = process.env.E2B_API_KEY
    delete process.env.E2B_API_KEY
    try {
      const ctx = new Context()
      await expect(ctx.plugin(E2BRuntime, {})).rejects.toThrow(/configure apiKey/)
    } finally {
      if (original === undefined) delete process.env.E2B_API_KEY
      else process.env.E2B_API_KEY = original
    }
  })
})

describe('E2B helpers and invariant companion', () => {
  it('quotes opaque shell arguments without interpolation', () => {
    expect(quoteE2BShellArg("a'b $HOME")).toBe("'a'\"'\"'b $HOME'")
  })

  it('registers the package-owned empty invariant installer', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry, { enabled: true })
    const fiber = await ctx.plugin(E2BInvariant).await()
    await fiber.dispose()
  })
})
