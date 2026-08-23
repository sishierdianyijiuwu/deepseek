// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import { AccountGate, type AccountGateProps } from '../src/client/AccountGate.tsx'
import { zh } from '../src/client/locales.ts'
import type { AuthResult, MeResult } from '../src/client/index.ts'

const t: AccountGateProps['t'] = makeTranslate(zh, commonZh)

function setup(overrides: Partial<AccountGateProps> = {}) {
  const props = {
    t,
    me: vi.fn(async (): Promise<MeResult> => ({ ok: true, signedIn: false })),
    register: vi.fn(async (): Promise<AuthResult> => ({ ok: true })),
    signIn: vi.fn(async (): Promise<AuthResult> => ({ ok: true })),
    signOut: vi.fn(async (): Promise<AuthResult> => ({ ok: true })),
    resend: vi.fn(async (): Promise<AuthResult> => ({ ok: true })),
    getSearch: () => '',
    replaceSearch: vi.fn(),
    ...overrides,
  } as unknown as AccountGateProps
  return { props, view: render(<AccountGate {...props} />) }
}

beforeEach(() => {
  const root = document.createElement('div')
  root.id = 'root'
  document.body.appendChild(root)
})

afterEach(() => {
  cleanup()
  document.body.replaceChildren()
})

describe('AccountGate', () => {
  it('loads sign-in, registers, resends, and signs in', async () => {
    const { props } = setup()
    await waitFor(() => { expect(screen.getByRole('heading', { name: '登录' })).toBeTruthy() })
    fireEvent.click(screen.getByRole('button', { name: '没有账户？注册' }))
    fireEvent.change(screen.getByLabelText('邮箱'), { target: { value: 'a@b.c' } })
    fireEvent.change(screen.getByLabelText('密码'), { target: { value: 'password12' } })
    fireEvent.submit(screen.getByRole('button', { name: '注册' }).closest('form')!)
    await waitFor(() => { expect(props.register).toHaveBeenCalledWith('a@b.c', 'password12') })
    expect(screen.getByText('查收邮件')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '重发验证邮件' }))
    await waitFor(() => { expect(props.resend).toHaveBeenCalledWith('a@b.c') })
    fireEvent.click(screen.getByRole('button', { name: '已有账户？登录' }))
    fireEvent.change(screen.getByLabelText('密码'), { target: { value: 'password12' } })
    fireEvent.submit(screen.getByRole('button', { name: '登录' }).closest('form')!)
    await waitFor(() => { expect(props.signIn).toHaveBeenCalled() })
    expect(screen.getByText('已登录 a@b.c')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '退出登录' }))
    await waitFor(() => { expect(props.signOut).toHaveBeenCalled() })
    expect(screen.getByRole('heading', { name: '登录' })).toBeTruthy()
  })

  it('shows verification notices, business errors, and network errors', async () => {
    const replaceSearch = vi.fn()
    setup({
      getSearch: () => '?verified=ok',
      replaceSearch,
    })
    await waitFor(() => { expect(screen.getByText('邮箱已验证，现在可以登录。')).toBeTruthy() })
    expect(replaceSearch).toHaveBeenCalled()
  })

  it('shows an invalid-link notice when /auth/me fails', async () => {
    setup({
      getSearch: () => 'verified=invalid',
      me: vi.fn(async () => {
        throw new Error('offline')
      }),
    })
    await waitFor(() => { expect(screen.getByText('无法连接到服务器')).toBeTruthy() })
    expect(screen.getByText('验证链接无效或已过期，请重新发送。')).toBeTruthy()
  })

  it('surfaces a business error and a network error on register', async () => {
    const register = vi.fn()
      .mockResolvedValueOnce({ ok: false, error: { code: 'email_taken', message: 'taken' } })
      .mockRejectedValueOnce(new Error('offline'))
    setup({ register })
    await waitFor(() => { expect(screen.getByRole('heading', { name: '登录' })).toBeTruthy() })
    fireEvent.click(screen.getByRole('button', { name: '没有账户？注册' }))
    fireEvent.change(screen.getByLabelText('邮箱'), { target: { value: 'a@b.c' } })
    fireEvent.change(screen.getByLabelText('密码'), { target: { value: 'password12' } })
    fireEvent.submit(screen.getByRole('button', { name: '注册' }).closest('form')!)
    await waitFor(() => { expect(screen.getByRole('alert').textContent).toBe('taken') })
    fireEvent.submit(screen.getByRole('button', { name: '注册' }).closest('form')!)
    await waitFor(() => { expect(screen.getByRole('alert').textContent).toBe('无法连接到服务器') })
  })

  it('renders the signed-in chip from /auth/me and ignores stale loads', async () => {
    let resolveMe!: (value: MeResult) => void
    const me = vi.fn(() => new Promise<MeResult>((resolve) => { resolveMe = resolve }))
    const { view } = setup({ me })
    view.unmount()
    resolveMe({ ok: true, signedIn: true, email: 'late@example.com' })
    await Promise.resolve()
    expect(screen.queryByText('已登录 late@example.com')).toBeNull()

    let rejectMe!: (reason: Error) => void
    const failingMe = vi.fn(() => new Promise<MeResult>((_, reject) => { rejectMe = reject }))
    const staleFail = setup({ me: failingMe })
    staleFail.view.unmount()
    rejectMe(new Error('offline'))
    await Promise.resolve()

    const signedIn = setup({
      me: vi.fn(async (): Promise<MeResult> => ({ ok: true, signedIn: true, email: 'me@example.com' })),
    })
    await waitFor(() => { expect(screen.getByText('已登录 me@example.com')).toBeTruthy() })
    expect(signedIn.props.replaceSearch).not.toHaveBeenCalled()
  })

  it('does not double-submit while busy', async () => {
    let resolveSignIn!: (value: AuthResult) => void
    const signIn = vi.fn(() => new Promise<AuthResult>((resolve) => { resolveSignIn = resolve }))
    setup({ signIn })
    await waitFor(() => { expect(screen.getByRole('heading', { name: '登录' })).toBeTruthy() })
    fireEvent.change(screen.getByLabelText('邮箱'), { target: { value: 'a@b.c' } })
    fireEvent.change(screen.getByLabelText('密码'), { target: { value: 'password12' } })
    const form = screen.getByRole('button', { name: '登录' }).closest('form')!
    fireEvent.submit(form)
    fireEvent.submit(form)
    expect(signIn).toHaveBeenCalledTimes(1)
    resolveSignIn({ ok: true })
    await waitFor(() => { expect(screen.getByText('已登录 a@b.c')).toBeTruthy() })
  })
})
