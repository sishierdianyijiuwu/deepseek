import { useEffect, useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { Button, Input, OnboardingSurface } from '@deepseek-ai/dsh-client-ui-primitives'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type { AccountGateInjected, AuthResult } from './index.ts'
import css from './AccountGate.module.css'

/** Full overlay-seat component props. */
export type AccountGateProps =
  PropsRuntime<'shell.overlay'>
  & InjectFace<AccountGateInjected>
  & PropsLocale<'account'>

type Screen = 'loading' | 'register' | 'sign-in' | 'check-email' | 'signed-in'

/**
 * Register / sign-in / sign-out overlay. Occupies the whole viewport until a
 * Sign-in session exists, then a small signed-in chip.
 * @param props - overlay runtime share, auth callbacks, and locale seat.
 * @returns the gate UI.
 */
export function AccountGate(props: AccountGateProps): ReactNode {
  const { me, register, signIn, signOut, resend, getSearch, replaceSearch, t } = props
  const [screen, setScreen] = useState<Screen>('loading')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [signedInEmail, setSignedInEmail] = useState('')

  useEffect(() => {
    let cancelled = false
    const search = getSearch()
    const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search)
    const verified = params.get('verified')
    const applyVerifiedNotice = (): void => {
      if (verified === 'ok') setNotice(t('verified.ok'))
      else if (verified === 'invalid') setNotice(t('verified.invalid'))
      if (verified !== null) replaceSearch()
    }
    void me().then((result) => {
      if (cancelled) return
      if (result.signedIn) {
        setSignedInEmail(result.email)
        setScreen('signed-in')
        return
      }
      applyVerifiedNotice()
      setScreen('sign-in')
    }, () => {
      if (cancelled) return
      applyVerifiedNotice()
      setError(t('error.network'))
      setScreen('sign-in')
    })
    return () => {
      cancelled = true
    }
  }, [getSearch, me, replaceSearch, t])

  const run = (task: () => Promise<AuthResult>, onOk: () => void): void => {
    if (busy) return
    setBusy(true)
    setError(null)
    void task().then((result) => {
      setBusy(false)
      if (!result.ok) {
        setError(result.error.message)
        return
      }
      onOk()
    }, () => {
      setBusy(false)
      setError(t('error.network'))
    })
  }

  const onRegister = (event: FormEvent): void => {
    event.preventDefault()
    run(() => register(email, password), () => { setScreen('check-email') })
  }

  const onSignIn = (event: FormEvent): void => {
    event.preventDefault()
    run(() => signIn(email, password), () => {
      setSignedInEmail(email)
      setScreen('signed-in')
    })
  }

  const onResend = (): void => {
    run(() => resend(email), () => { setNotice(t('checkEmail.body')) })
  }

  const onSignOut = (): void => {
    run(() => signOut(), () => {
      setSignedInEmail('')
      setPassword('')
      setNotice(null)
      setScreen('sign-in')
    })
  }

  if (screen === 'loading') return null

  if (screen === 'signed-in') {
    return (
      <div className={css.chip}>
        <span>{t('signedIn.as', { email: signedInEmail })}</span>
        <Button variant="outline" size="sm" disabled={busy} onClick={onSignOut}>
          {t('signOut')}
        </Button>
      </div>
    )
  }

  const title = screen === 'register'
    ? t('title.register')
    : screen === 'check-email'
      ? t('title.checkEmail')
      : t('title.signIn')

  return (
    <OnboardingSurface>
      <form className={css.form} onSubmit={screen === 'register' ? onRegister : onSignIn}>
        <h1 className={css.title}>{title}</h1>
        {notice !== null && <p className={css.notice}>{notice}</p>}
        {screen === 'check-email' && <p className={css.notice}>{t('checkEmail.body')}</p>}
        <label className={css.label}>
          {t('email')}
          <Input
            type="email"
            autoComplete="username"
            value={email}
            onChange={(event) => { setEmail(event.target.value) }}
            required
          />
        </label>
        {screen !== 'check-email' && (
          <label className={css.label}>
            {t('password')}
            <Input
              type="password"
              autoComplete={screen === 'register' ? 'new-password' : 'current-password'}
              value={password}
              onChange={(event) => { setPassword(event.target.value) }}
              required
            />
          </label>
        )}
        {error !== null && <p className={css.error} role="alert">{error}</p>}
        <div className={css.actions}>
          {screen === 'register' && (
            <Button variant="primary" disabled={busy} type="submit">
              {busy ? t('busy') : t('submit.register')}
            </Button>
          )}
          {screen === 'sign-in' && (
            <Button variant="primary" disabled={busy} type="submit">
              {busy ? t('busy') : t('submit.signIn')}
            </Button>
          )}
          {screen === 'check-email' && (
            <Button variant="primary" disabled={busy} type="button" onClick={onResend}>
              {busy ? t('busy') : t('submit.resend')}
            </Button>
          )}
          {screen !== 'sign-in' && (
            <Button
              variant="ghost"
              disabled={busy}
              type="button"
              onClick={() => { setError(null); setScreen('sign-in') }}
            >
              {t('switch.toSignIn')}
            </Button>
          )}
          {screen === 'sign-in' && (
            <Button
              variant="ghost"
              disabled={busy}
              type="button"
              onClick={() => { setError(null); setScreen('register') }}
            >
              {t('switch.toRegister')}
            </Button>
          )}
        </div>
      </form>
    </OnboardingSurface>
  )
}
