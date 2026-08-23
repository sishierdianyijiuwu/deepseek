/**
 * PostgreSQL query adapter: `pg` for a connection URL, PGlite for `pglite:`.
 * @module @deepseek-ai/dsh-account-postgres/sql
 */

import pg from 'pg'
import { PGlite } from '@electric-sql/pglite'

/** One SQL client: parameterized queries and a single-flight transaction. */
export interface SqlClient {
  /**
   * Run one parameterized statement.
   * @param text - SQL with `$1` placeholders.
   * @param params - bound values.
   * @returns the result rows.
   */
  query(text: string, params?: readonly unknown[]): Promise<{ rows: Record<string, unknown>[] }>
  /**
   * Run `fn` in one transaction; roll back on rejection.
   * @param fn - work that uses the same client.
   * @returns the callback result.
   */
  transaction<T>(fn: (sql: SqlClient) => Promise<T>): Promise<T>
  /** Release pooled clients or close the in-process engine. */
  close(): Promise<void>
}

/**
 * Open a SQL client.
 * @param url - `postgres://…` / `postgresql://…` for `pg`, `pglite:` for an
 *   in-process engine, or `pglite:<dir>` for a directory-backed engine.
 * @param label - error prefix for a non-postgres URL.
 * @returns a connected client; a failed `pg` connection rejects.
 */
export async function openSql(url: string, label = 'account-postgres'): Promise<SqlClient> {
  if (url === 'pglite:') return new PgliteSql()
  if (url.startsWith('pglite:')) {
    const dataDir = url.slice('pglite:'.length)
    if (dataDir === '') {
      throw new Error(`${label}: url must be a postgres:// URL or pglite:`)
    }
    return new PgliteSql(dataDir)
  }
  if (!url.startsWith('postgres://') && !url.startsWith('postgresql://')) {
    throw new Error(`${label}: url must be a postgres:// URL or pglite:`)
  }
  const pool = new pg.Pool({ connectionString: url })
  await pool.query('SELECT 1')
  return new PgSql(pool)
}

/**
 * Whether `error` is a unique-constraint violation (SQLSTATE 23505).
 * @param error - driver error from `query` or `transaction`.
 * @returns true when the SQLSTATE is 23505.
 */
export function isUniqueViolation(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  return (error as { code?: unknown }).code === '23505'
}

class PgSql implements SqlClient {
  constructor(private readonly pool: pg.Pool, private readonly client?: pg.PoolClient) {}

  async query(text: string, params: readonly unknown[] = []): Promise<{ rows: Record<string, unknown>[] }> {
    const target = this.client ?? this.pool
    const result = await target.query(text, params as unknown[])
    return { rows: result.rows as Record<string, unknown>[] }
  }

  async transaction<T>(fn: (sql: SqlClient) => Promise<T>): Promise<T> {
    if (this.client !== undefined) return fn(this)
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const result = await fn(new PgSql(this.pool, client))
      await client.query('COMMIT')
      return result
    } catch (error) {
      try {
        await client.query('ROLLBACK')
      } catch {
        // The connection is being released; the original error is the one callers act on.
      }
      throw error
    } finally {
      client.release()
    }
  }

  async close(): Promise<void> {
    if (this.client !== undefined) return
    await this.pool.end()
  }
}

class PgliteSql implements SqlClient {
  private readonly db: PGlite
  private nested = false

  /**
   * @param dataDir - optional directory for a durable PGlite store.
   */
  constructor(dataDir?: string) {
    this.db = dataDir === undefined ? new PGlite() : new PGlite(dataDir)
  }

  async query(text: string, params: readonly unknown[] = []): Promise<{ rows: Record<string, unknown>[] }> {
    const result = await this.db.query(text, params as unknown[])
    return { rows: result.rows as Record<string, unknown>[] }
  }

  async transaction<T>(fn: (sql: SqlClient) => Promise<T>): Promise<T> {
    if (this.nested) return fn(this)
    this.nested = true
    try {
      return await this.db.transaction(async (tx) => {
        const inner: SqlClient = {
          query: async (text, params = []) => {
            const result = await tx.query(text, params as unknown[])
            return { rows: result.rows as Record<string, unknown>[] }
          },
          transaction: callback => callback(inner),
          close: () => Promise.resolve(),
        }
        return fn(inner)
      })
    } finally {
      this.nested = false
    }
  }

  async close(): Promise<void> {
    await this.db.close()
  }
}
