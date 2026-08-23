/**
 * The bundle's substance is its patch file: the `dsh.bundle.patch` manifest
 * field must name a real, parseable patch list whose plugin names are
 * declared dependencies.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import * as yaml from 'js-yaml'
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include'
import * as HostedInvariant from '../src/invariant.ts'
import {} from '../src/index.ts'

describe('dsh-hosted bundle', () => {
  it('declares a parseable patch list of Account rows', () => {
    const root = fileURLToPath(new URL('..', import.meta.url))
    const manifest = JSON.parse(
      readFileSync(resolve(root, 'package.json'), 'utf8'),
    ) as {
      dependencies?: Record<string, string>
      dsh?: { bundle?: { patch?: string } }
    }
    expect(manifest.dsh?.bundle?.patch).toBe('./cordis.patch.yml')
    const parsed = yaml.load(
      readFileSync(resolve(root, manifest.dsh!.bundle!.patch!), 'utf8'),
      { schema: entryListSchema },
    )
    expect(Array.isArray(parsed)).toBe(true)
    const rows = (parsed as { insert?: { id?: string; name?: string }[] }[]).flatMap(
      patch => patch.insert ?? [],
    )
    const ids = rows.map(row => row.id)
    expect(ids).toEqual(['e2b', 'mailer', 'accounts', 'cloud-workspaces', 'account-http', 'ui-account'])
    for (const row of rows) {
      expect(manifest.dependencies).toHaveProperty(row.name ?? '')
    }
    const overrides = (parsed as { id?: string; name?: string; disabled?: boolean; inject?: string[] }[])
      .filter(patch => patch.id !== undefined)
    expect(overrides.map(patch => patch.id)).toEqual([
      'credentials',
      'subprocess',
      'fs-sandbox',
      'bash-sandbox',
      'sandbox',
      'sandbox-policy',
      'directory-picker',
      'api-gateway',
    ])
    expect(overrides.find(patch => patch.id === 'api-gateway')?.inject).toEqual(['e2b'])
    expect(overrides.find(patch => patch.id === 'credentials')?.name).toBe('@deepseek-ai/dsh-credentials-account')
    expect(overrides.find(patch => patch.id === 'subprocess')?.name).toBe('@deepseek-ai/dsh-subprocess-e2b')
    expect(overrides.find(patch => patch.id === 'fs-sandbox')?.name).toBe('@deepseek-ai/dsh-fs-e2b')
    expect(overrides.find(patch => patch.id === 'bash-sandbox')?.name).toBe('@deepseek-ai/dsh-bash-local')
    expect(overrides.find(patch => patch.id === 'sandbox')?.disabled).toBe(true)
    expect(manifest.dependencies).toHaveProperty('@deepseek-ai/dsh-credentials-account')
    expect(manifest.dependencies).toHaveProperty('@deepseek-ai/dsh-e2b')
    expect(manifest.dependencies).toHaveProperty('@deepseek-ai/dsh-fs-e2b')
    expect(manifest.dependencies).toHaveProperty('@deepseek-ai/dsh-subprocess-e2b')
  })
})

describe('invariant companion', () => {
  it('registers the package ownership with an empty installer', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry, { enabled: true })
    await expect(ctx.plugin(HostedInvariant).await()).resolves.toBeDefined()
  })
})
