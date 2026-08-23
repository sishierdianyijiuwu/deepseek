/**
 * The hosted reverse-proxy files terminate HTTPS in front of loopback dsh.
 * Assertions read the shipped Caddyfile and compose, not a running Caddy.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const reverseProxyDir = fileURLToPath(new URL('../reverse-proxy/', import.meta.url))

describe('hosted TLS reverse proxy', () => {
  it('terminates HTTPS in front of loopback dsh and does not bind all interfaces', () => {
    const caddyfile = readFileSync(resolve(reverseProxyDir, 'Caddyfile'), 'utf8')
    const compose = readFileSync(resolve(reverseProxyDir, 'compose.yml'), 'utf8')

    expect(caddyfile).toMatch(/^\{\$DSH_PUBLIC_HOST:localhost\} \{/m)
    expect(caddyfile).not.toMatch(/^https?:\/\//m)
    expect(caddyfile).not.toMatch(/auto_https\s+off/)
    expect(caddyfile).toMatch(/reverse_proxy\s+127\.0\.0\.1:3080/)
    expect(caddyfile).toMatch(/header_up\s+Host\s+\{host\}/)
    expect(caddyfile).not.toMatch(/0\.0\.0\.0/)

    expect(compose).toMatch(/image:\s*caddy:2\.10\.2-alpine/)
    expect(compose).toMatch(/network_mode:\s*host/)
    expect(compose).toMatch(/DSH_PUBLIC_HOST/)
    expect(compose).not.toMatch(/0\.0\.0\.0/)
    expect(compose).not.toMatch(/@deepseek-ai\/dsh-hosted/)
    expect(compose).not.toMatch(/^\s+command:/m)
  })
})
