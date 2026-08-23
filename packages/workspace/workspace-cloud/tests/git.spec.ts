import { mkdir, mkdtemp, open, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CloudWorkspaceQuotaError, MAX_WORKSPACE_BYTES } from '../src/files.ts'
import {
  clonePublicGit,
  CloudWorkspaceImportError,
  CloudWorkspaceImportUrlError,
  DEFAULT_WORKSPACE_TITLE,
  parsePublicHttpsGitUrl,
  redactGitUrl,
  titleFromGitUrl,
} from '../src/git.ts'
import { createBareRepo, generateSelfSignedTls, listenGitHttps } from './git-http-fixture.ts'

let dest: string | undefined

afterEach(async () => {
  if (dest !== undefined) await rm(dest, { recursive: true, force: true })
  dest = undefined
})

describe('parsePublicHttpsGitUrl', () => {
  it('accepts a public HTTPS remote and derives a title', () => {
    const url = parsePublicHttpsGitUrl(' https://github.com/acme/notes.git ')
    expect(url.href).toBe('https://github.com/acme/notes.git')
    expect(titleFromGitUrl(url)).toBe('notes')
    expect(titleFromGitUrl(parsePublicHttpsGitUrl('https://example.com/org/repo'))).toBe('repo')
    expect(titleFromGitUrl(parsePublicHttpsGitUrl('https://example.com/'))).toBe(DEFAULT_WORKSPACE_TITLE)
    expect(titleFromGitUrl(parsePublicHttpsGitUrl('https://example.com/.git'))).toBe(DEFAULT_WORKSPACE_TITLE)
  })

  it('refuses non-HTTPS, credential-bearing, and unparseable remotes without echoing secrets', () => {
    const rejected = [
      '',
      'not a url',
      'http://github.com/acme/notes.git',
      'git://github.com/acme/notes.git',
      'ssh://git@github.com/acme/notes.git',
      'git@github.com:acme/notes.git',
      'file:///tmp/notes.git',
      'https://user:token@github.com/acme/notes.git',
      'https://user@github.com/acme/notes.git',
      'https://:token@github.com/acme/notes.git',
    ]
    for (const gitUrl of rejected) {
      try {
        parsePublicHttpsGitUrl(gitUrl)
        throw new Error(`expected refusal of ${gitUrl}`)
      } catch (error: unknown) {
        expect(error).toBeInstanceOf(CloudWorkspaceImportUrlError)
        expect(String(error)).not.toContain('token')
        expect((error as CloudWorkspaceImportUrlError).gitUrl).not.toContain('token')
        expect((error as CloudWorkspaceImportUrlError).message).toBe('git URL is not a public HTTPS remote')
      }
    }
    expect(redactGitUrl('https://user:token@github.com/acme/notes.git'))
      .toBe('https://github.com/acme/notes.git')
  })
})

describe('clonePublicGit', () => {
  it('refuses a credential URL object and fails closed off-loopback without using the public internet', {
    timeout: 20_000,
  }, async () => {
    dest = await mkdtemp(join(tmpdir(), 'dsh-git-clone-'))
    const cancelled = new AbortController()
    cancelled.abort()
    await expect(clonePublicGit(parsePublicHttpsGitUrl('https://invalid.invalid/notes.git'), dest, {
      signal: cancelled.signal, timeoutMs: 5_000,
    })).rejects.toMatchObject({ name: 'CloudWorkspaceImportError', reason: 'cancelled' })
    await expect(clonePublicGit(new URL('https://user:token@example.com/acme/notes.git'), dest, {
      timeoutMs: 5_000,
    })).rejects.toBeInstanceOf(CloudWorkspaceImportUrlError)
    await expect(clonePublicGit(parsePublicHttpsGitUrl('https://invalid.invalid/notes.git'), dest, {
      timeoutMs: 5_000,
    })).rejects.toMatchObject({ name: 'CloudWorkspaceImportError', reason: 'refused' })
    await expect(clonePublicGit(parsePublicHttpsGitUrl('https://localhost:1/notes.git'), dest, {
      timeoutMs: 5_000,
    })).rejects.toBeInstanceOf(CloudWorkspaceImportError)
    await expect(clonePublicGit(parsePublicHttpsGitUrl('https://[::1]:1/notes.git'), dest, {
      timeoutMs: 5_000,
    })).rejects.toBeInstanceOf(CloudWorkspaceImportError)
    await expect(clonePublicGit(parsePublicHttpsGitUrl('https://invalid.invalid/notes.git'), dest))
      .rejects.toBeInstanceOf(CloudWorkspaceImportError)
  })

  it('aborts when dest grows past 1 GiB during a hung clone', {
    timeout: 20_000,
  }, async () => {
    dest = await mkdtemp(join(tmpdir(), 'dsh-git-oversize-'))
    const tlsDir = join(dest, 'tls')
    await mkdir(tlsDir)
    const tls = await generateSelfSignedTls(tlsDir)
    const gitRoot = join(dest, 'git')
    await mkdir(gitRoot)
    await createBareRepo(gitRoot, 'notes', { 'README.md': 'ok\n' })
    const hang = await listenGitHttps({ root: gitRoot, key: tls.key, cert: tls.cert, hang: true })
    const cloneDest = join(dest, 'clone')
    await mkdir(cloneDest)
    try {
      const pending = clonePublicGit(parsePublicHttpsGitUrl(hang.url('notes')), cloneDest, {
        tlsInsecure: true, timeoutMs: 10_000,
      })
      await new Promise((resolve) => { setTimeout(resolve, 200) })
      await mkdir(cloneDest, { recursive: true })
      const pad = await open(join(cloneDest, 'pad'), 'w')
      await pad.truncate(MAX_WORKSPACE_BYTES + 1)
      await pad.close()
      await expect(pending).rejects.toBeInstanceOf(CloudWorkspaceQuotaError)
    } finally {
      await hang.close()
    }
  })
})
