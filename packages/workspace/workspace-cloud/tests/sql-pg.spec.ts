import { afterEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  failConnect: false,
  failBegin: false,
  failWork: false,
  failRollback: false,
  ended: false,
}))

vi.mock('pg', () => {
  class Client {
    async query(text: string) {
      if (text === 'BEGIN' && state.failBegin) throw new Error('begin')
      if (text === 'ROLLBACK') {
        if (state.failRollback) throw new Error('rollback')
        return { rows: [] }
      }
      if (text === 'COMMIT') return { rows: [] }
      if (state.failWork) throw new Error('work')
      return { rows: [{ n: 1 }] }
    }
    release(): void {}
  }
  class Pool {
    async query() {
      if (state.failConnect) throw new Error('connect')
      return { rows: [{ n: 1 }] }
    }
    async connect() {
      return new Client()
    }
    async end() {
      state.ended = true
    }
  }
  return { default: { Pool } }
})

const { isUniqueViolation, openSql } = await import('../src/sql.ts')

afterEach(() => {
  state.failConnect = false
  state.failBegin = false
  state.failWork = false
  state.failRollback = false
  state.ended = false
})

describe('sql adapter', () => {
  it('rejects a non-postgres URL and reports unique-violation codes', async () => {
    await expect(openSql('mysql://x')).rejects.toThrow(/postgres:\/\//)
    expect(isUniqueViolation({ code: '23505' })).toBe(true)
    expect(isUniqueViolation({ code: '23503' })).toBe(false)
    expect(isUniqueViolation(null)).toBe(false)
    expect(isUniqueViolation('x')).toBe(false)
  })

  it('opens pg, runs a transaction, rolls back, and closes', async () => {
    const sql = await openSql('postgres://example')
    await expect(sql.transaction(inner => inner.query('SELECT 1'))).resolves.toEqual({ rows: [{ n: 1 }] })
    state.failWork = true
    await expect(sql.transaction(inner => inner.query('SELECT 1'))).rejects.toThrow('work')
    state.failWork = false
    state.failBegin = true
    await expect(sql.transaction(inner => inner.query('SELECT 1'))).rejects.toThrow('begin')
    state.failBegin = false
    state.failWork = true
    state.failRollback = true
    await expect(sql.transaction(inner => inner.query('SELECT 1'))).rejects.toThrow('work')
    await sql.close()
    expect(state.ended).toBe(true)
  })

  it('rejects a failed pg connect', async () => {
    state.failConnect = true
    await expect(openSql('postgres://example')).rejects.toThrow('connect')
  })
})
