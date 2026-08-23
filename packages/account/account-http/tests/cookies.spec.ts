import { Readable } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { describe, expect, it, vi } from 'vitest'
import { cookieValue, MAX_AUTH_BODY_BYTES, readJsonObject, serializeCookie } from '../src/index.ts'

describe('cookie helpers', () => {
  it('reads, skips empty parts, and rejects a malformed percent-escape', () => {
    expect(cookieValue(undefined, 'dsh_sign_in')).toBeUndefined()
    expect(cookieValue('', 'dsh_sign_in')).toBeUndefined()
    expect(cookieValue('other=1; dsh_sign_in=abc; extra=2', 'dsh_sign_in')).toBe('abc')
    expect(cookieValue('=novalue; dsh_sign_in=zz', 'dsh_sign_in')).toBe('zz')
    expect(cookieValue('dsh_sign_in=%zz', 'dsh_sign_in')).toBeUndefined()
    expect(cookieValue('foo=bar', 'dsh_sign_in')).toBeUndefined()
  })

  it('caps a streamed body without Content-Length', async () => {
    const writeHead = vi.fn()
    const req = Object.assign(Readable.from([Buffer.alloc(MAX_AUTH_BODY_BYTES + 1)]), {
      headers: { 'content-type': 'application/json' },
      destroy: vi.fn(),
    }) as unknown as IncomingMessage
    const res = { writeHead, end: vi.fn() } as unknown as ServerResponse
    await expect(readJsonObject(req, res)).resolves.toBeUndefined()
    expect(writeHead).toHaveBeenCalledWith(413)
  })

  it('serializes HttpOnly Lax cookies and the Secure flag', () => {
    expect(serializeCookie('dsh_sign_in', 'tok', 10, false))
      .toBe('dsh_sign_in=tok; Path=/; HttpOnly; SameSite=Lax; Max-Age=10')
    expect(serializeCookie('dsh_sign_in', '', -5, true))
      .toContain('Secure')
    expect(serializeCookie('dsh_sign_in', '', -5, true))
      .toContain('Max-Age=0')
  })
})
