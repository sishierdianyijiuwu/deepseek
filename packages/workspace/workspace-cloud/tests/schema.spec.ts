import { describe, expect, it } from 'vitest'
import { ensureSchema, SCHEMA_VERSION } from '../src/schema.ts'
import { openSql } from '@deepseek-ai/dsh-account-postgres'

describe('schema', () => {
  it('migrates PGlite, is idempotent, and refuses a foreign version', { timeout: 20_000 }, async () => {
    const sql = await openSql('pglite:')
    await ensureSchema(sql)
    await ensureSchema(sql)
    expect(SCHEMA_VERSION).toBe(1)
    const nested = await sql.transaction(async (inner) => {
      await inner.close()
      await inner.transaction(async nestedInner => nestedInner.query('SELECT 1 AS x'))
      return sql.transaction(async () => {
        const ping = await inner.query('SELECT 1 AS x')
        return ping.rows[0]?.['x']
      })
    })
    expect(nested).toBe(1)
    await sql.query('UPDATE cloud_workspace_schema SET version = 99')
    await expect(ensureSchema(sql)).rejects.toThrow(/schema version 99/)
    await sql.close()
  })
})
