// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SlotRegistry } from '@deepseek-ai/dsh-client-runtime/client'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { AccountGate } from '../src/client/AccountGate.tsx'
import type { AccountGateInjected } from '../src/client/index.ts'
import { apply, inject } from '../src/client/index.ts'
import { apply as nodeApply } from '../src/index.ts'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('ui-account browser apply', () => {
  it('declares every service it binds', () => {
    expect(inject).toEqual(['slots', 'locale'])
  })

  it('node-half apply is an intentional no-op', () => {
    expect(() => { nodeApply() }).not.toThrow()
  })

  it('registers the gate after the overlay seat exists and talks to auth HTTP', async () => {
    const ctx = new Context()
    await ctx.plugin(SlotRegistry).await()
    ctx.slots.register({
      name: 'root',
      children: { 'shell.overlay': { kind: 'list', scope: 'root' } },
    } as never, () => null)
    ctx.provide('locale', new LocaleRuntime(ctx))
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    const entry = ctx.slots.entries('shell.overlay')[0]!
    expect(entry.component).toBe(AccountGate)
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = typeof input === 'string' ? input : input instanceof URL ? input.pathname : input.url
      if (path === '/auth/me' && init?.method === undefined) {
        return new Response(JSON.stringify({ ok: true, signedIn: false }))
      }
      return new Response(JSON.stringify({ ok: true }))
    })
    vi.stubGlobal('fetch', fetchMock)
    window.history.replaceState(null, '', '/?verified=ok')
    const injected = (entry.inject as unknown as () => AccountGateInjected)()
    await expect(injected.me()).resolves.toEqual({ ok: true, signedIn: false })
    await expect(injected.register('a@b.c', 'pw')).resolves.toEqual({ ok: true })
    await expect(injected.signIn('a@b.c', 'pw')).resolves.toEqual({ ok: true })
    await expect(injected.signOut()).resolves.toEqual({ ok: true })
    await expect(injected.resend('a@b.c')).resolves.toEqual({ ok: true })
    expect(injected.getSearch()).toBe('?verified=ok')
    injected.replaceSearch()
    expect(window.location.search).toBe('')
    await fiber.dispose()
    expect(ctx.slots.entries('shell.overlay')).toHaveLength(0)
  })
})
