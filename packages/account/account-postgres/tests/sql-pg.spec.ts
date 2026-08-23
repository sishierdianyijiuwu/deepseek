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

const { openSql } = await import('../src/sql.ts')

afterEach(() => {
  state.failConnect = false
  state.failBegin = false
  state.failWork = false
  state.failRollback = false
  state.ended = false
})

describe('pg SQL adapter', () => {
  it('queries, commits, rolls back, and closes a pool', async () => {
    const sql = await openSql('postgres://example/db')
    expect((await sql.query('SELECT 1 AS n')).rows[0]?.['n']).toBe(1)
    await expect(sql.transaction(async (inner) => {
      await inner.close()
      return inner.transaction(nested => nested.query('SELECT 1'))
    })).resolves.toMatchObject({ rows: [{ n: 1 }] })

    state.failWork = true
    await expect(sql.transaction(async inner => inner.query('SELECT 1'))).rejects.toThrow('work')
    state.failWork = false

    state.failWork = true
    state.failRollback = true
    await expect(sql.transaction(async inner => inner.query('SELECT 1'))).rejects.toThrow('work')
    state.failWork = false
    state.failRollback = false

    state.failBegin = true
    await expect(sql.transaction(async inner => inner.query('SELECT 1'))).rejects.toThrow('begin')
    state.failBegin = false

    await sql.close()
    expect(state.ended).toBe(true)
  })

  it('fails loud when the pool cannot connect', async () => {
    state.failConnect = true
    await expect(openSql('postgresql://example/db')).rejects.toThrow('connect')
  })
})
