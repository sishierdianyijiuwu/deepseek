/**
 * Cloud Workspace control-plane schema. Pre-release: a mismatch fails loud.
 * @module @deepseek-ai/dsh-workspace-cloud/schema
 */

import type { SqlClient } from '@deepseek-ai/dsh-account-postgres'

/** Monotonic schema version stored in `cloud_workspace_schema`. */
export const SCHEMA_VERSION = 1

const DDL: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS cloud_workspace_schema (
  version INTEGER PRIMARY KEY
)`,
  `CREATE TABLE IF NOT EXISTS cloud_workspaces (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  title TEXT NOT NULL,
  path TEXT NOT NULL UNIQUE,
  slot INTEGER NOT NULL CHECK (slot >= 0 AND slot <= 2),
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  UNIQUE (account_id, slot)
)`,
]

/**
 * Apply the current schema or refuse a foreign version.
 * @param sql - connected client.
 */
export async function ensureSchema(sql: SqlClient): Promise<void> {
  for (const statement of DDL) {
    await sql.query(statement)
  }
  const existing = await sql.query('SELECT version FROM cloud_workspace_schema LIMIT 1')
  const rawVersion = existing.rows[0]?.['version']
  if (rawVersion === undefined) {
    await sql.query('INSERT INTO cloud_workspace_schema (version) VALUES ($1)', [SCHEMA_VERSION])
    return
  }
  const version = Number(rawVersion)
  if (version !== SCHEMA_VERSION) {
    throw new Error(
      `workspace-cloud: schema version ${String(version)} is not ${String(SCHEMA_VERSION)}; `
      + 'pre-release control-plane storage has no compatibility promise',
    )
  }
}
