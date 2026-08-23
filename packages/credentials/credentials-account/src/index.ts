/**
 * Account-scoped credentials provider (`ctx.credentials`) for the hosted
 * control plane. Each signed-in Account has its own document under
 * `$DSH_HOME/credentials/<accountId>.json`. The process environment is never
 * a source: a platform key would be shared across Accounts. Resolve is
 * per call, so a Models-page write reaches the next LLM request without a
 * restart. Writes require {@link currentAccountId}; resolution without a
 * bound Account is unconfigured rather than another Account's secret.
 * @module @deepseek-ai/dsh-credentials-account
 */

import { mkdir, readFile, unlink } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { currentAccountId, type AccountId } from '@deepseek-ai/dsh-account'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import {
  CredentialProvider,
  credentialRef,
  parseCredentialKey,
  type ApiKeyRecord,
  type CredentialInfo,
  type CredentialKey,
  type CredentialRecord,
  type CredentialRecordEntry,
  type CredentialRecordInfo,
  type CredentialRef,
  type ResolvedCredential,
} from '@deepseek-ai/dsh-credentials'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'

/** Directory under the harness home that holds one document per Account. */
export const CREDENTIALS_DIRNAME = 'credentials'

/** Layout version of each Account document. */
export const DOCUMENT_VERSION = 1

/** Source layer id this provider reports. */
export const ACCOUNT_SOURCE = 'account'

/** Plugin config: storage location. */
export interface Config {
  /** Harness home used when resolving the credentials directory; defaults to `$DSH_HOME` or `~/.dsh`. */
  dshHome?: string
}

/** Fully resolved provider parameters; defaulting happens here, never inline. */
interface ResolvedSpec {
  directory: string
}

/**
 * Resolve the per-Account document directory from plugin config.
 * @param config - raw plugin config.
 * @returns the directory that holds `<accountId>.json` files.
 */
export function resolveSpec(config: Config): ResolvedSpec {
  return { directory: resolve(join(resolveDshHome(config.dshHome), CREDENTIALS_DIRNAME)) }
}

/** Account ids that can name a document; rejects path separators. */
const ACCOUNT_FILE_PATTERN = /^[A-Za-z0-9._-]+$/

/** How long a document write waits for the cross-process writer lock. */
const DOCUMENT_LOCK_WAIT_MS = 30_000

interface AccountDocument {
  refs: Map<string, string>
  records: Map<string, CredentialRecord>
}

function emptyDocument(): AccountDocument {
  return { refs: new Map(), records: new Map() }
}

function isENOENT(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT'
}

function filenameFor(directory: string, account: AccountId): string {
  return join(directory, `${account}.json`)
}

/**
 * Account-scoped credentials provider. The launching environment is not a
 * layer: hosted LLM calls use only the signed-in Account's stored secret.
 */
export class AccountCredentialProvider extends CredentialProvider {
  static inject = ['accounts']

  static Config: z<Config> = z.object({
    dshHome: z.string(),
  })

  private readonly spec: ResolvedSpec
  private readonly cache = new Map<string, AccountDocument>()
  private operations: Promise<void> = Promise.resolve()
  private closed = false

  constructor(ctx: Context, public config: Config) {
    super(ctx)
    this.spec = resolveSpec(config)
  }

  *[Service.init](): Generator<() => Promise<void>, void, void> {
    yield async () => {
      this.closed = true
      await this.operations
    }
  }

  override resolve(ref: CredentialRef): Promise<ResolvedCredential | undefined> {
    return this.withDocument((doc) => {
      const value = doc?.refs.get(ref)
      return value === undefined ? undefined : { value, source: ACCOUNT_SOURCE }
    })
  }

  override describe(ref: CredentialRef): Promise<CredentialInfo> {
    return this.withDocument((doc) => {
      if (doc === undefined) return { configured: false, writable: false }
      const value = doc.refs.get(ref)
      if (value === undefined) return { configured: false, writable: true }
      return { configured: true, source: ACCOUNT_SOURCE, writable: true }
    })
  }

  override async set(ref: CredentialRef, value: string): Promise<void> {
    if (value.length === 0) {
      throw new Error(`credentials-account: an empty value cannot be stored for "${ref}"; use unset`)
    }
    await this.writeRef(ref, value)
  }

  override async unset(ref: CredentialRef): Promise<void> {
    await this.writeRef(ref, undefined)
  }

  override readRecord(key: CredentialKey): Promise<CredentialRecord | undefined> {
    return this.withDocument(doc => doc?.records.get(key))
  }

  override describeRecord(key: CredentialKey): Promise<CredentialRecordInfo> {
    return this.withDocument((doc) => {
      if (doc === undefined) return { configured: false, writable: false }
      const stored = doc.records.get(key)
      if (stored === undefined) return { configured: false, writable: true }
      return { configured: true, kind: stored.kind, writable: true }
    })
  }

  override listRecords(): Promise<readonly CredentialRecordEntry[]> {
    return this.withDocument((doc) => {
      if (doc === undefined) return []
      return [...doc.records].map(([key, record]) => ({
        key: parseCredentialKey(key),
        kind: record.kind,
      }))
    })
  }

  override hasStoredSecret(): Promise<boolean> {
    return this.withDocument((doc) => {
      if (doc === undefined) return false
      return doc.refs.size > 0 || doc.records.size > 0
    })
  }

  override async modifyRecord(
    key: CredentialKey,
    mutate: (current: CredentialRecord | undefined) => Promise<CredentialRecord | undefined>,
  ): Promise<CredentialRecord | undefined> {
    const account = this.requireAccount('modify')
    return this.enqueue(async () => {
      this.assertOpen(`modify "${key}"`)
      await mkdir(this.spec.directory, { recursive: true, mode: 0o700 })
      const filename = filenameFor(this.spec.directory, account)
      return withFileLock(filename, async () => {
        const doc = await this.loadFromDisk(account)
        const current = doc.records.get(key)
        const next = await mutate(current)
        if (next === undefined) return current
        assertStorable(key, next)
        if (next.kind === 'grant') assertJsonValue(`record "${key}" payload`, next.payload, new Set())
        doc.records.set(key, next)
        await this.persist(account, doc, filename)
        this.notifyRecordUpdated(key)
        return next
      }, { waitMs: DOCUMENT_LOCK_WAIT_MS })
    })
  }

  override async deleteRecord(key: CredentialKey): Promise<void> {
    const account = this.requireAccount('delete')
    await this.enqueue(async () => {
      this.assertOpen(`delete "${key}"`)
      await mkdir(this.spec.directory, { recursive: true, mode: 0o700 })
      const filename = filenameFor(this.spec.directory, account)
      await withFileLock(filename, async () => {
        const doc = await this.loadFromDisk(account)
        if (!doc.records.has(key)) return
        doc.records.delete(key)
        await this.persist(account, doc, filename)
        this.notifyRecordUpdated(key)
      }, { waitMs: DOCUMENT_LOCK_WAIT_MS })
    })
  }

  /**
   * Delete the Account document and drop its cache entry. Missing files are a no-op.
   * @param accountId - Account whose `$DSH_HOME/credentials/<accountId>.json` is erased.
   */
  override async eraseOwned(accountId: string): Promise<void> {
    if (!ACCOUNT_FILE_PATTERN.test(accountId)) return
    const account = accountId as AccountId
    await this.enqueue(async () => {
      const filename = filenameFor(this.spec.directory, account)
      try {
        await unlink(filename)
      } catch (error) {
        if (!isENOENT(error)) throw error
      }
      this.cache.delete(account)
    })
  }

  private async writeRef(ref: CredentialRef, value: string | undefined): Promise<void> {
    const verb = value === undefined ? 'unset' : 'set'
    const account = this.requireAccount(verb)
    await this.enqueue(async () => {
      this.assertOpen(`${verb} "${ref}"`)
      await mkdir(this.spec.directory, { recursive: true, mode: 0o700 })
      const filename = filenameFor(this.spec.directory, account)
      await withFileLock(filename, async () => {
        const doc = await this.loadFromDisk(account)
        const existing = doc.refs.get(ref)
        if (value === undefined && existing === undefined) return
        if (value === undefined) doc.refs.delete(ref)
        else doc.refs.set(ref, value)
        await this.persist(account, doc, filename)
        this.notifyUpdated(ref)
      }, { waitMs: DOCUMENT_LOCK_WAIT_MS })
    })
  }

  private async withDocument<T>(read: (doc: AccountDocument | undefined) => T): Promise<T> {
    const account = this.tryAccount()
    if (account === undefined) return read(undefined)
    const cached = this.cache.get(account)
    if (cached !== undefined) return read(cached)
    return this.enqueue(async () => {
      if (this.closed) return read(undefined)
      return read(await this.loadFromDisk(account))
    })
  }

  private async loadFromDisk(account: AccountId): Promise<AccountDocument> {
    const filename = filenameFor(this.spec.directory, account)
    let text: string
    try {
      text = await readFile(filename, 'utf8')
    } catch (error) {
      if (!isENOENT(error)) throw error
      const empty = emptyDocument()
      this.cache.set(account, empty)
      return empty
    }
    const parsed = parseAccountDocument(text, filename)
    this.cache.set(account, parsed)
    return parsed
  }

  private async persist(account: AccountId, doc: AccountDocument, filename: string): Promise<void> {
    const text = `${JSON.stringify({
      version: DOCUMENT_VERSION,
      refs: Object.fromEntries(doc.refs),
      records: Object.fromEntries(doc.records),
    }, null, 2)}\n`
    await writeFileAtomic(filename, text, { mode: 0o600, dirMode: 0o700 })
    this.cache.set(account, doc)
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const task = this.operations.then(operation)
    this.operations = task.then(() => undefined, () => undefined)
    return task
  }

  private assertOpen(action: string): void {
    if (this.closed) throw new Error(`credentials-account is disposed: cannot ${action}`)
  }

  private tryAccount(): AccountId | undefined {
    const id = currentAccountId()
    if (id === undefined) return undefined
    if (!ACCOUNT_FILE_PATTERN.test(id)) return undefined
    return id
  }

  private requireAccount(verb: string): AccountId {
    const id = currentAccountId()
    if (id === undefined) {
      throw new Error(`credentials-account: ${verb} requires a signed-in Account`)
    }
    if (!ACCOUNT_FILE_PATTERN.test(id)) {
      throw new Error('credentials-account: Account id cannot name a credentials document')
    }
    return id
  }
}

/**
 * Parse one Account credentials document. Unknown versions, extra top-level
 * keys, empty values, and unaddressable keys fail loud rather than skip.
 * @param text - document text.
 * @param filename - path quoted in errors.
 * @returns parsed references and records.
 */
export function parseAccountDocument(text: string, filename: string): AccountDocument {
  let root: unknown
  try {
    root = JSON.parse(text) as unknown
  } catch (error) {
    throw new Error(`credentials-account: invalid JSON at ${filename}`, { cause: error })
  }
  if (typeof root !== 'object' || root === null || Array.isArray(root)) {
    throw new TypeError(`credentials-account: ${filename} must be an object`)
  }
  const fields = root as Record<string, unknown>
  for (const key of Object.keys(fields)) {
    if (key !== 'version' && key !== 'refs' && key !== 'records') {
      throw new Error(`credentials-account: unknown top-level key "${key}" in ${filename}`)
    }
  }
  if (fields['version'] !== DOCUMENT_VERSION) {
    throw new Error(
      `credentials-account: ${filename} declares version ${JSON.stringify(fields['version'])};`
      + ` this build reads version ${DOCUMENT_VERSION}`,
    )
  }
  return {
    refs: parseRefs(fields['refs'], filename),
    records: parseRecords(fields['records'], filename),
  }
}

function parseRefs(section: unknown, filename: string): Map<string, string> {
  const entries = new Map<string, string>()
  if (section === undefined || section === null) return entries
  if (typeof section !== 'object' || Array.isArray(section)) {
    throw new TypeError(`credentials-account: "refs" in ${filename} must be an object`)
  }
  for (const [key, value] of Object.entries(section as Record<string, unknown>)) {
    credentialRef(key)
    if (typeof value !== 'string') {
      throw new TypeError(`credentials-account: the value for "${key}" in ${filename} must be a string`)
    }
    if (value.length === 0) {
      throw new Error(`credentials-account: the value for "${key}" in ${filename} is empty; remove the key instead`)
    }
    entries.set(key, value)
  }
  return entries
}

function parseRecords(section: unknown, filename: string): Map<string, CredentialRecord> {
  const entries = new Map<string, CredentialRecord>()
  if (section === undefined || section === null) return entries
  if (typeof section !== 'object' || Array.isArray(section)) {
    throw new TypeError(`credentials-account: "records" in ${filename} must be an object`)
  }
  for (const [key, value] of Object.entries(section as Record<string, unknown>)) {
    parseCredentialKey(key)
    entries.set(key, parseRecord(key, value, filename))
  }
  return entries
}

function parseRecord(key: string, value: unknown, filename: string): CredentialRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(`credentials-account: record "${key}" in ${filename} must be an object`)
  }
  const fields = value as Record<string, unknown>
  const kind = fields['kind']
  if (kind === 'api-key') {
    assertFields(key, fields, ['kind', 'key', 'env'], filename)
    const apiKey = fields['key']
    if (apiKey !== undefined && (typeof apiKey !== 'string' || apiKey.length === 0)) {
      throw new TypeError(`credentials-account: record "${key}" in ${filename} has a non-string or empty key`)
    }
    const env = parseRecordEnv(key, fields['env'], filename)
    const record: ApiKeyRecord = {
      kind: 'api-key',
      ...apiKey === undefined ? {} : { key: apiKey },
      ...env === undefined ? {} : { env },
    }
    return record
  }
  if (kind === 'grant') {
    assertFields(key, fields, ['kind', 'payload'], filename)
    if (!('payload' in fields)) {
      throw new TypeError(`credentials-account: record "${key}" in ${filename} is missing payload`)
    }
    return { kind: 'grant', payload: fields['payload'] }
  }
  throw new TypeError(`credentials-account: record "${key}" in ${filename} has unknown kind ${JSON.stringify(kind)}`)
}

function parseRecordEnv(
  key: string,
  env: unknown,
  filename: string,
): Readonly<Record<string, string>> | undefined {
  if (env === undefined) return undefined
  if (typeof env !== 'object' || env === null || Array.isArray(env)) {
    throw new TypeError(`credentials-account: record "${key}" env in ${filename} must be an object`)
  }
  const parsed: Record<string, string> = {}
  for (const [name, value] of Object.entries(env as Record<string, unknown>)) {
    credentialRef(name)
    if (typeof value !== 'string' || value.length === 0) {
      throw new TypeError(`credentials-account: record "${key}" env "${name}" in ${filename} must be a non-empty string`)
    }
    parsed[name] = value
  }
  return parsed
}

function assertFields(key: string, fields: Record<string, unknown>, allowed: readonly string[], filename: string): void {
  for (const name of Object.keys(fields)) {
    if (!allowed.includes(name)) {
      throw new Error(`credentials-account: record "${key}" in ${filename} has unknown field "${name}"`)
    }
  }
}

function assertStorable(key: CredentialKey, record: CredentialRecord): void {
  if (record.kind !== 'api-key') return
  if (record.key !== undefined && record.key.length === 0) {
    throw new TypeError(`credentials-account: record "${key}" has an empty key; omit the field instead`)
  }
  for (const [name, value] of Object.entries(record.env ?? {})) {
    credentialRef(name)
    if (value.length === 0) {
      throw new TypeError(`credentials-account: record "${key}" env "${name}" must be a non-empty string`)
    }
  }
}

function assertJsonValue(where: string, value: unknown, seen: Set<object>): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return
  if (typeof value === 'number') {
    if (Number.isFinite(value)) return
    throw new TypeError(`credentials-account: ${where} holds a non-finite number`)
  }
  if (typeof value === 'object') {
    if (seen.has(value)) throw new TypeError(`credentials-account: ${where} is cyclic`)
    if (Object.getPrototypeOf(value) === Object.prototype || Array.isArray(value)) {
      seen.add(value)
      for (const nested of Object.values(value)) assertJsonValue(where, nested, seen)
      seen.delete(value)
      return
    }
  }
  throw new TypeError(`credentials-account: ${where} holds a value JSON cannot represent`)
}

export default AccountCredentialProvider
