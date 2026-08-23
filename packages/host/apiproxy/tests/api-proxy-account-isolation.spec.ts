/**
 * When Accounts are composed, session.list and lookup are the signed-in
 * Account's Sessions only. HTTP with two cookie jars is the source of truth;
 * this pins the in-process ApiProxy filter the Host route binds.
 */

import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { Accounts, accountId, runWithAccount } from '@deepseek-ai/dsh-account'
import type { RegisterResult, SignInLookup, SignInResult, SignInSessionId, VerifyEmailResult } from '@deepseek-ai/dsh-account'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent, AgentHandle, CreateAgentOptions } from '@deepseek-ai/dsh-agent'
import SessionStore from '@deepseek-ai/dsh-session'
import type { SessionId } from '@deepseek-ai/dsh-session'
import UserQuestionService from '@deepseek-ai/dsh-user-questions'
import type { ApiProxy, RpcRequest } from '@deepseek-ai/dsh-host-apiproxy/api'
import { RpcId } from '@deepseek-ai/dsh-host-apiproxy/api/rpc'
import { createApiProxy } from '@deepseek-ai/dsh-host-apiproxy'

const sid = (id: string): SessionId => id as SessionId
const accountA = accountId('account-a')
const accountB = accountId('account-b')

let nextRpc = 1
function request<P>(payload: P): RpcRequest<P> {
  return { rpcId: RpcId(`iso-${String(nextRpc++)}`), payload }
}

class FakeAccounts extends Accounts {
  override register(): Promise<RegisterResult> {
    return Promise.resolve({ ok: true })
  }
  override verifyEmail(): Promise<VerifyEmailResult> {
    return Promise.resolve({ ok: true })
  }
  override resendVerification(): Promise<void> {
    return Promise.resolve()
  }
  override signIn(): Promise<SignInResult> {
    return Promise.resolve({ ok: false, error: 'invalid_credentials' })
  }
  override signOut(_signInId: SignInSessionId): Promise<void> {
    return Promise.resolve()
  }
  override lookupSignIn(_signInId: SignInSessionId): Promise<SignInLookup | undefined> {
    return Promise.resolve(undefined)
  }
}

async function harness(): Promise<{ ctx: Context; api: ApiProxy }> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(UserQuestionService)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(FakeAccounts)
  ctx.agents.setFactory({
    createAgent: async (ownerCtx: Context, options: CreateAgentOptions): Promise<AgentHandle> => {
      const session = ctx.sessions.create(options.sessionId, {
        ...options.seed === undefined ? {} : { seed: [...options.seed] },
        ...options.meta === undefined ? {} : { meta: options.meta },
      })
      const agent = {} as Agent
      const agentCtx = ownerCtx.extend({ agent })
      Object.assign(agent, {
        id: session.id,
        session,
        status: 'idle',
        ctx: agentCtx,
        inbox: { nextTurn: [], nextStep: [] },
        cancel: () => undefined,
      })
      await options.setup?.(agentCtx)
      ctx.agents.register(agent)
      return { agent, dispose: () => Promise.resolve() }
    },
    resume: () => Promise.reject(new Error('isolation tests create live sessions')),
  })
  return {
    ctx,
    api: createApiProxy(ctx, {
      defaultModelSelection: () => ({ provider: 'p', model: 'm' }),
      cwd: '/tmp',
    }),
  }
}

describe('Account-owned Sessions', () => {
  it('lists, creates, and looks up only the signed-in Account\'s Sessions', async () => {
    const { ctx, api } = await harness()

    const created = await runWithAccount(accountA, () => api.sessions.create(request({})))
    expect(created.result.ok).toBe(true)
    if (!created.result.ok) throw new Error('create failed')
    const sessionId = created.result.value.sessionId
    expect(ctx.sessions.get(sessionId)?.header.owner).toBe(accountA)

    const listedA = await runWithAccount(accountA, () => api.sessions.list(request({})))
    expect(listedA.result.ok).toBe(true)
    if (!listedA.result.ok) throw new Error('list A failed')
    expect(listedA.result.value.items.map(item => item.sessionId)).toEqual([sessionId])

    const listedB = await runWithAccount(accountB, () => api.sessions.list(request({})))
    expect(listedB.result.ok).toBe(true)
    if (!listedB.result.ok) throw new Error('list B failed')
    expect(listedB.result.value.items).toEqual([])

    const historyB = await runWithAccount(accountB, () => api.sessions.history(request({ sessionId })))
    expect(historyB.result.ok).toBe(false)
    if (historyB.result.ok) throw new Error('cross-account history must fail')
    expect(historyB.result.error.code).toBe('session-not-found')

    const promptB = await runWithAccount(accountB, () => api.sessions.prompt(request({
      sessionId,
      mode: 'queue' as const,
      content: [{ type: 'text' as const, text: 'hi' }],
    })))
    expect(promptB.result.ok).toBe(false)
    if (promptB.result.ok) throw new Error('cross-account prompt must fail')
    expect(promptB.result.error.code).toBe('session-not-found')

    const queueA = await runWithAccount(accountA, () => api.sessions.updateQueue(request({
      sessionId,
      itemId: 'item-1' as never,
      action: { kind: 'remove' as const },
    })))
    expect(queueA.result.ok).toBe(false)
    if (queueA.result.ok) throw new Error('own-session updateQueue should reach the inbox')
    expect(queueA.result.error.code).toBe('queue-item-not-found')

    const cancelB = await runWithAccount(accountB, () => api.sessions.cancel(request({ sessionId })))
    expect(cancelB.result.ok).toBe(false)
    if (cancelB.result.ok) throw new Error('cross-account cancel must fail')
    expect(cancelB.result.error.code).toBe('session-not-found')

    const queueB = await runWithAccount(accountB, () => api.sessions.updateQueue(request({
      sessionId,
      itemId: 'item-1' as never,
      action: { kind: 'remove' as const },
    })))
    expect(queueB.result.ok).toBe(false)
    if (queueB.result.ok) throw new Error('cross-account updateQueue must fail')
    expect(queueB.result.error.code).toBe('session-not-found')

    const exportB = await runWithAccount(accountB, () => api.downloads.sessionLog(
      { sessionId },
      new AbortController().signal,
    ))
    expect(exportB.status).toBe(404)
    expect(await exportB.text()).toBe('session not found')

    const describeA = await runWithAccount(accountA, () => api.host.describe(request({})))
    const describeB = await runWithAccount(accountB, () => api.host.describe(request({})))
    expect(describeA.result.ok).toBe(true)
    expect(describeB.result.ok).toBe(true)
    if (describeA.result.ok) expect(describeA.result.value.attachedSessions).toBe(1)
    if (describeB.result.ok) expect(describeB.result.value.attachedSessions).toBe(0)

    const searchSessions = vi.fn((_req: { sessionFilters?: unknown }) => Promise.resolve({ items: [] }))
    ctx.provide('sessionQuery', { searchSessions } as never)
    await runWithAccount(accountA, () => api.sessions.search(
      request({ query: 'hit' }),
      new AbortController().signal,
    ))
    expect(searchSessions.mock.calls[0]?.[0]).toMatchObject({
      sessionFilters: [{ kind: 'id', values: [sessionId] }],
    })
  })

  it('hides a Session whose header has no owner', async () => {
    const { ctx, api } = await harness()
    ctx.sessions.create(sid('orphan'), { meta: { cwd: '/tmp' } })
    const listed = await runWithAccount(accountA, () => api.sessions.list(request({})))
    expect(listed.result.ok).toBe(true)
    if (!listed.result.ok) throw new Error('list failed')
    expect(listed.result.value.items).toEqual([])
    const history = await runWithAccount(accountA, () => api.sessions.history(request({ sessionId: sid('orphan') })))
    expect(history.result.ok).toBe(false)
    if (history.result.ok) throw new Error('unowned history must fail')
    expect(history.result.error.code).toBe('session-not-found')
  })
})
