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

type Screen =
  | 'loading'
  | 'register'
  | 'sign-in'
  | 'check-email'
  | 'forgot'
  | 'check-reset'
  | 'reset'
  | 'signed-in'

/**
 * Register / sign-in / password-reset / sign-out / Deletion overlay. Occupies
 * the whole viewport until a Sign-in session exists, then a small signed-in chip.
 * @param props - overlay runtime share, auth callbacks, and locale seat.
 * @returns the gate UI.
 */
export function AccountGate(props: AccountGateProps): ReactNode {
  const {
    me, register, signIn, signOut, deleteAccount, resend, requestPasswordReset,
    resetPassword, getSearch, replaceSearch, t,
  } = props
  const [screen, setScreen] = useState<Screen>('loading')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [resetToken, setResetToken] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<{ code: string; message: string } | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [signedInEmail, setSignedInEmail] = useState('')
  const [confirmingDelete, setConfirmingDelete] = useState(false)

  useEffect(() => {
    let cancelled = false
    const search = getSearch()
    const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search)
    const applyLanding = (): boolean => {
      if (params.has('reset')) {
        const token = params.get('reset') || ''
        replaceSearch()
        if (token === '') {
          setNotice(t('reset.invalid'))
          setScreen('sign-in')
        } else {
          setResetToken(token)
          setPassword('')
          setScreen('reset')
        }
        return true
      }
      const verified = params.get('verified')
      if (verified === 'ok') setNotice(t('verified.ok'))
      else if (verified === 'invalid') setNotice(t('verified.invalid'))
      if (verified !== null) replaceSearch()
      return false
    }
    void me().then((result) => {
      if (cancelled) return
      if (applyLanding()) return
      if (result.signedIn) {
        setSignedInEmail(result.email)
        setScreen('signed-in')
        return
      }
      setScreen('sign-in')
    }, () => {
      if (cancelled) return
      if (applyLanding()) return
      setError({ code: 'network', message: t('error.network') })
      setScreen('sign-in')
    })
    return () => {
      cancelled = true
    }
  }, [getSearch, me, replaceSearch, t])

  const run = (
    task: () => Promise<AuthResult>,
    onOk: () => void,
    onFail?: (code: string) => void,
  ): void => {
    if (busy) return
    setBusy(true)
    setError(null)
    void task().then((result) => {
      setBusy(false)
      if (!result.ok) {
        setError(result.error)
        onFail?.(result.error.code)
        return
      }
      onOk()
    }, () => {
      setBusy(false)
      setError({ code: 'network', message: t('error.network') })
    })
  }

  const onRegister = (event: FormEvent): void => {
    event.preventDefault()
    run(() => register(email, password), () => { setScreen('check-email') }, (code) => {
      if (code === 'mail_failed') setScreen('check-email')
    })
  }

  const onSignIn = (event: FormEvent): void => {
    event.preventDefault()
    run(() => signIn(email, password), () => {
      setSignedInEmail(email)
      setScreen('signed-in')
    })
  }

  const onResend = (event?: FormEvent): void => {
    event?.preventDefault()
    run(() => resend(email), () => {
      setError(null)
      setNotice(t('checkEmail.body'))
    })
  }

  const onForgot = (event: FormEvent): void => {
    event.preventDefault()
    run(() => requestPasswordReset(email), () => {
      setNotice(null)
      setScreen('check-reset')
    })
  }

  const onResendReset = (event?: FormEvent): void => {
    event?.preventDefault()
    run(() => requestPasswordReset(email), () => {
      setError(null)
      setNotice(t('checkReset.body'))
    })
  }

  const onReset = (event: FormEvent): void => {
    event.preventDefault()
    run(() => resetPassword(resetToken, password), () => {
      setPassword('')
      setResetToken('')
      setNotice(t('reset.ok'))
      setScreen('sign-in')
    })
  }

  const onSignOut = (): void => {
    run(() => signOut(), () => {
      setSignedInEmail('')
      setPassword('')
      setNotice(null)
      setConfirmingDelete(false)
      setScreen('sign-in')
    })
  }

  const onDelete = (): void => {
    run(() => deleteAccount(), () => {
      setSignedInEmail('')
      setPassword('')
      setNotice(null)
      setConfirmingDelete(false)
      setScreen('sign-in')
    })
  }

  if (screen === 'loading') return null

  if (screen === 'signed-in') {
    if (confirmingDelete) {
      return (
        <div className={css.chip}>
          <span>{t('delete.confirm')}</span>
          <Button variant="primary" size="sm" disabled={busy} onClick={onDelete}>
            {busy ? t('busy') : t('delete.yes')}
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() => { setConfirmingDelete(false) }}
          >
            {t('delete.cancel')}
          </Button>
        </div>
      )
    }
    return (
      <div className={css.chip}>
        <span>{t('signedIn.as', { email: signedInEmail })}</span>
        <Button variant="outline" size="sm" disabled={busy} onClick={onSignOut}>
          {t('signOut')}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          disabled={busy}
          onClick={() => { setConfirmingDelete(true) }}
        >
          {t('deleteAccount')}
        </Button>
      </div>
    )
  }

  const title = screen === 'register'
    ? t('title.register')
    : screen === 'check-email'
      ? t('title.checkEmail')
      : screen === 'forgot'
        ? t('title.forgot')
        : screen === 'check-reset'
          ? t('title.checkReset')
          : screen === 'reset'
            ? t('title.reset')
            : t('title.signIn')
  const onSubmit = screen === 'register'
    ? onRegister
    : screen === 'check-email'
      ? onResend
      : screen === 'forgot'
        ? onForgot
        : screen === 'check-reset'
          ? onResendReset
          : screen === 'reset'
            ? onReset
            : onSignIn
  const offerResend = error?.code === 'unverified' || error?.code === 'email_taken'
  const resendLabel = busy ? t('busy') : t('submit.resend')
  const showEmail = screen !== 'reset'
  const showPassword = screen === 'register' || screen === 'sign-in' || screen === 'reset'
  const passwordAutoComplete = screen === 'sign-in' ? 'current-password' : 'new-password'

  return (
    <OnboardingSurface>
      <form className={css.form} onSubmit={onSubmit}>
        <h1 className={css.title}>{title}</h1>
        {notice !== null && <p className={css.notice}>{notice}</p>}
        {screen === 'check-email' && error?.code !== 'mail_failed' && (
          <p className={css.notice}>{t('checkEmail.body')}</p>
        )}
        {screen === 'check-reset' && (
          <p className={css.notice}>{t('checkReset.body')}</p>
        )}
        {showEmail && (
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
        )}
        {showPassword && (
          <label className={css.label}>
            {t('password')}
            <Input
              type="password"
              autoComplete={passwordAutoComplete}
              value={password}
              onChange={(event) => { setPassword(event.target.value) }}
              required
            />
          </label>
        )}
        {error !== null && <p className={css.error} role="alert">{error.message}</p>}
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
            <Button variant="primary" disabled={busy} type="submit">
              {resendLabel}
            </Button>
          )}
          {screen === 'forgot' && (
            <Button variant="primary" disabled={busy} type="submit">
              {busy ? t('busy') : t('submit.forgot')}
            </Button>
          )}
          {screen === 'check-reset' && (
            <Button variant="primary" disabled={busy} type="submit">
              {busy ? t('busy') : t('submit.resendReset')}
            </Button>
          )}
          {screen === 'reset' && (
            <Button variant="primary" disabled={busy} type="submit">
              {busy ? t('busy') : t('submit.reset')}
            </Button>
          )}
          {offerResend && (
            <Button variant="primary" disabled={busy} type="button" onClick={() => { onResend() }}>
              {resendLabel}
            </Button>
          )}
          {screen === 'sign-in' && (
            <Button
              variant="ghost"
              disabled={busy}
              type="button"
              onClick={() => { setError(null); setNotice(null); setScreen('forgot') }}
            >
              {t('switch.forgot')}
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
