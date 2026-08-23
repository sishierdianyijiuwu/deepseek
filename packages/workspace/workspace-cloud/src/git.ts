/**
 * Public HTTPS git Import: URL checks and an isolated `git clone`.
 * @module @deepseek-ai/dsh-workspace-cloud/src/git
 */

import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { CloudWorkspaceQuotaError, MAX_WORKSPACE_BYTES, treeBytes } from './files.ts'

const execFileAsync = promisify(execFile)

/** Display title used when create or Import omits one. */
export const DEFAULT_WORKSPACE_TITLE = 'Workspace'

/** Bound on a single Import clone when the caller does not abort sooner. */
export const IMPORT_CLONE_TIMEOUT_MS = 300_000

/** Poll dest size while `git clone` runs so a huge pack cannot fill the host. */
const IMPORT_SIZE_POLL_MS = 100

/** The git URL is not a public HTTPS remote (scheme, credentials, or host). */
export class CloudWorkspaceImportUrlError extends Error {
  /**
   * @param gitUrl - redacted remote (never userinfo).
   */
  constructor(readonly gitUrl: string) {
    super('git URL is not a public HTTPS remote')
    this.name = 'CloudWorkspaceImportUrlError'
  }
}

/** `git clone` of a public HTTPS remote failed (private, not git, cancelled, or timed out). */
export class CloudWorkspaceImportError extends Error {
  /**
   * @param gitUrl - redacted remote (never userinfo).
   * @param reason - stable failure class; never exec argv or stderr.
   */
  constructor(
    readonly gitUrl: string,
    readonly reason: 'cancelled' | 'timed-out' | 'refused' = 'refused',
  ) {
    super(
      reason === 'cancelled'
        ? 'git Import was cancelled'
        : reason === 'timed-out'
          ? 'git Import timed out'
          : 'cannot Import this git remote',
    )
    this.name = 'CloudWorkspaceImportError'
  }
}

/**
 * Strip userinfo from a git URL for logs and RPC details.
 * @param raw - caller-supplied remote.
 * @returns an https URL without userinfo, or a placeholder when unparseable.
 */
export function redactGitUrl(raw: string): string {
  try {
    const parsed = new URL(raw.trim())
    parsed.username = ''
    parsed.password = ''
    return parsed.protocol === 'https:' ? parsed.href : 'https://invalid.invalid/'
  } catch {
    return 'https://invalid.invalid/'
  }
}

/**
 * Parse `raw` as a public HTTPS git remote: `https:` only, no userinfo.
 * @param raw - caller-supplied remote.
 * @returns the parsed URL.
 */
export function parsePublicHttpsGitUrl(raw: string): URL {
  const trimmed = raw.trim()
  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    throw new CloudWorkspaceImportUrlError(redactGitUrl(raw))
  }
  if (parsed.protocol !== 'https:' || parsed.username !== '' || parsed.password !== '') {
    throw new CloudWorkspaceImportUrlError(redactGitUrl(raw))
  }
  return parsed
}

/**
 * Display title from the last path segment of a public HTTPS git URL.
 * @param url - parsed public HTTPS remote.
 * @returns basename without a trailing `.git`, or {@link DEFAULT_WORKSPACE_TITLE}.
 */
export function titleFromGitUrl(url: URL): string {
  const segments = url.pathname.split('/').filter(part => part !== '')
  const last = segments.at(-1)
  if (last === undefined) return DEFAULT_WORKSPACE_TITLE
  const trimmed = last.replace(/\.git$/i, '')
  return trimmed === '' ? DEFAULT_WORKSPACE_TITLE : trimmed
}

/** Options for {@link clonePublicGit}. */
export interface ClonePublicGitOptions {
  /** Caller abort (unary RPC signal). */
  signal?: AbortSignal
  /** Wall-clock bound; defaults to {@link IMPORT_CLONE_TIMEOUT_MS}. */
  timeoutMs?: number
  /** Skip TLS verify (local self-signed fixtures only). */
  tlsInsecure?: boolean
}

/**
 * Clone `url` into `dest` with credential helpers off, file/ssh/git/ext
 * protocols denied, no checkout symlinks, and no HTTP redirects. Dest growth
 * past 1 GiB aborts the clone. Loopback TLS skip is not implied; pass
 * `tlsInsecure` for a self-signed local fixture.
 * @param url - parsed public HTTPS remote.
 * @param dest - empty destination directory.
 * @param options - abort, timeout, and TLS skip.
 * @returns resolution after a successful clone.
 */
export async function clonePublicGit(
  url: URL,
  dest: string,
  options: ClonePublicGitOptions = {},
): Promise<void> {
  parsePublicHttpsGitUrl(url.href)
  const redacted = redactGitUrl(url.href)
  const caller = options.signal
  if (signalAborted(caller)) throw new CloudWorkspaceImportError(redacted, 'cancelled')
  const timeoutMs = options.timeoutMs ?? IMPORT_CLONE_TIMEOUT_MS
  const home = await mkdtemp(join(tmpdir(), 'dsh-git-home-'))
  const emptyConfig = join(home, 'config')
  await writeFile(emptyConfig, '')
  const args = [
    '-c', 'credential.helper=',
    '-c', 'core.askPass=',
    '-c', 'core.symlinks=false',
    '-c', 'http.followRedirects=false',
    '-c', 'protocol.file.allow=never',
    '-c', 'protocol.ext.allow=never',
    '-c', 'protocol.git.allow=never',
    '-c', 'protocol.ssh.allow=never',
    ...options.tlsInsecure === true ? ['-c', 'http.sslVerify=false'] : [],
    'clone', '--quiet', '--no-recurse-submodules', '--', url.href, dest,
  ]
  const sizeAbort = new AbortController()
  const timeoutAbort = AbortSignal.timeout(timeoutMs)
  const combined = AbortSignal.any([
    sizeAbort.signal,
    timeoutAbort,
    ...caller === undefined ? [] : [caller],
  ])
  let oversize = false
  const poll = setInterval(() => {
    void (async () => {
      const bytes = await treeBytes(dest)
      if (bytes > MAX_WORKSPACE_BYTES) {
        oversize = true
        sizeAbort.abort()
      }
    })()
  }, IMPORT_SIZE_POLL_MS)
  try {
    await execFileAsync('git', args, {
      encoding: 'utf8',
      maxBuffer: 4 * 1024 * 1024,
      signal: combined,
      killSignal: 'SIGKILL',
      env: {
        PATH: process.env['PATH'],
        HOME: home,
        TMPDIR: home,
        GIT_TERMINAL_PROMPT: '0',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: emptyConfig,
        GIT_CONFIG_SYSTEM: emptyConfig,
      },
    })
  } catch (_error: unknown) {
    if (oversize) {
      throw new CloudWorkspaceQuotaError(0, Math.max(await treeBytes(dest), MAX_WORKSPACE_BYTES + 1))
    }
    if (signalAborted(caller)) throw new CloudWorkspaceImportError(redacted, 'cancelled')
    if (timeoutAbort.aborted) throw new CloudWorkspaceImportError(redacted, 'timed-out')
    throw new CloudWorkspaceImportError(redacted, 'refused')
  } finally {
    clearInterval(poll)
    await rm(home, { recursive: true, force: true })
  }
  if (await treeBytes(dest) > MAX_WORKSPACE_BYTES) {
    throw new CloudWorkspaceQuotaError(0, await treeBytes(dest))
  }
}

function signalAborted(signal: AbortSignal | undefined): boolean {
  return signal !== undefined && signal.aborted
}
