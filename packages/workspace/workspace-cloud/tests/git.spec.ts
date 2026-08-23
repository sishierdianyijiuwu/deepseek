import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  clonePublicGit,
  CloudWorkspaceImportError,
  CloudWorkspaceImportUrlError,
  DEFAULT_WORKSPACE_TITLE,
  isLoopbackHost,
  parsePublicHttpsGitUrl,
  titleFromGitUrl,
} from '../src/git.ts'

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

  it('refuses non-HTTPS, credential-bearing, and unparseable remotes', () => {
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
      expect(() => parsePublicHttpsGitUrl(gitUrl), gitUrl).toThrow(CloudWorkspaceImportUrlError)
    }
  })
})

describe('isLoopbackHost', () => {
  it('recognizes loopback spellings and rejects a public host', () => {
    expect(isLoopbackHost('localhost')).toBe(true)
    expect(isLoopbackHost('127.0.0.1')).toBe(true)
    expect(isLoopbackHost('[::1]')).toBe(true)
    expect(isLoopbackHost('::1')).toBe(true)
    expect(isLoopbackHost('example.com')).toBe(false)
  })
})

describe('clonePublicGit', () => {
  it('refuses a credential URL object and fails closed off-loopback without using the public internet', {
    timeout: 20_000,
  }, async () => {
    dest = await mkdtemp(join(tmpdir(), 'dsh-git-clone-'))
    await expect(clonePublicGit(new URL('https://user:token@example.com/acme/notes.git'), dest))
      .rejects.toBeInstanceOf(CloudWorkspaceImportUrlError)
    await expect(clonePublicGit(parsePublicHttpsGitUrl('https://invalid.invalid/notes.git'), dest))
      .rejects.toBeInstanceOf(CloudWorkspaceImportError)
    await expect(clonePublicGit(parsePublicHttpsGitUrl('https://localhost:1/notes.git'), dest))
      .rejects.toBeInstanceOf(CloudWorkspaceImportError)
    await expect(clonePublicGit(parsePublicHttpsGitUrl('https://[::1]:1/notes.git'), dest))
      .rejects.toBeInstanceOf(CloudWorkspaceImportError)
  })
})
