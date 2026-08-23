/**
 * Public HTTPS git Import: URL checks and an isolated `git clone`.
 * @module @deepseek-ai/dsh-workspace-cloud/src/git
 */

import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/** Display title used when create or Import omits one. */
export const DEFAULT_WORKSPACE_TITLE = 'Workspace'

/** The git URL is not a public HTTPS remote (scheme, credentials, or host). */
export class CloudWorkspaceImportUrlError extends Error {
  /**
   * @param gitUrl - caller-supplied remote.
   */
  constructor(readonly gitUrl: string) {
    super(`git URL '${gitUrl}' is not a public HTTPS remote`)
    this.name = 'CloudWorkspaceImportUrlError'
  }
}

/** `git clone` of a public HTTPS remote failed (private, not git, or transport). */
export class CloudWorkspaceImportError extends Error {
  /**
   * @param gitUrl - normalized HTTPS remote.
   * @param detail - clone stderr or failure text.
   */
  constructor(readonly gitUrl: string, detail: string) {
    super(`cannot Import '${gitUrl}': ${detail}`)
    this.name = 'CloudWorkspaceImportError'
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
    throw new CloudWorkspaceImportUrlError(raw)
  }
  if (parsed.protocol !== 'https:' || parsed.username !== '' || parsed.password !== '') {
    throw new CloudWorkspaceImportUrlError(raw)
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

/**
 * Clone `gitUrl` into `dest` with credential helpers off and file/ssh/git
 * protocols denied. Loopback HTTPS skips TLS verify so tests can use a
 * self-signed local fixture; public remotes keep git's default verify.
 * @param url - parsed public HTTPS remote.
 * @param dest - empty destination directory.
 * @returns resolution after a successful clone.
 */
export async function clonePublicGit(url: URL, dest: string): Promise<void> {
  parsePublicHttpsGitUrl(url.href)
  const home = await mkdtemp(join(tmpdir(), 'dsh-git-home-'))
  const emptyConfig = join(home, 'config')
  await writeFile(emptyConfig, '')
  const args = [
    '-c', 'credential.helper=',
    '-c', 'core.askPass=',
    '-c', 'protocol.file.allow=never',
    '-c', 'protocol.ext.allow=never',
    '-c', 'protocol.git.allow=never',
    '-c', 'protocol.ssh.allow=never',
    ...isLoopbackHost(url.hostname) ? ['-c', 'http.sslVerify=false'] : [],
    'clone', '--quiet', '--no-recurse-submodules', '--', url.href, dest,
  ]
  try {
    await execFileAsync('git', args, {
      encoding: 'utf8',
      maxBuffer: 4 * 1024 * 1024,
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
  } catch (error: unknown) {
    throw new CloudWorkspaceImportError(url.href, String(error))
  } finally {
    await rm(home, { recursive: true, force: true })
  }
}

/**
 * Whether TLS verify can be skipped because the remote is this host.
 * @param host - URL hostname (IPv6 may include brackets).
 * @returns true for localhost, 127.0.0.1, and ::1.
 */
export function isLoopbackHost(host: string): boolean {
  const normalized = host.replace(/^\[|\]$/g, '').toLowerCase()
  return normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '::1'
}
