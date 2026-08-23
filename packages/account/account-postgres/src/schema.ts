/**
 * Account control-plane schema. Pre-release: a mismatch fails loud; no compatibility.
 * @module @deepseek-ai/dsh-account-postgres/schema
 */

import type { SqlClient } from './sql.ts'

/** Monotonic schema version stored in `account_schema`. */
export const SCHEMA_VERSION = 3

const DDL: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS account_schema (
  version INTEGER PRIMARY KEY
)`,
  `CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  email_normalized TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  verified_at BIGINT,
  banned_at BIGINT,
  created_at BIGINT NOT NULL
)`,
  `CREATE TABLE IF NOT EXISTS email_verification_tokens (
  token_hash TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  expires_at BIGINT NOT NULL
)`,
  `CREATE TABLE IF NOT EXISTS sign_in_sessions (
  id_hash TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  created_at BIGINT NOT NULL,
  expires_at BIGINT NOT NULL
)`,
  `CREATE TABLE IF NOT EXISTS password_reset_tokens (
  token_hash TEXT PRIMARY KEY,
  account_id TEXT NOT NULL UNIQUE REFERENCES accounts(id) ON DELETE CASCADE,
  expires_at BIGINT NOT NULL
)`,
  `CREATE TABLE IF NOT EXISTS registration_control (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  frozen_at BIGINT
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
  const existing = await sql.query('SELECT version FROM account_schema LIMIT 1')
  const rawVersion = existing.rows[0]?.['version']
  if (rawVersion === undefined) {
    await sql.query('INSERT INTO account_schema (version) VALUES ($1)', [SCHEMA_VERSION])
    return
  }
  const version = Number(rawVersion)
  if (version !== SCHEMA_VERSION) {
    throw new Error(
      `account-postgres: schema version ${String(version)} is not ${String(SCHEMA_VERSION)}; `
      + 'pre-release control-plane storage has no compatibility promise',
    )
  }
}
