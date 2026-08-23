/**
 * Local HTTPS git-http-backend fixture for Import tests. Not the public internet.
 */

import { execFile, spawn } from 'node:child_process'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createServer } from 'node:https'
import { mkdir, open, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export interface GitHttpsFixture {
  /** `https://127.0.0.1:<port>/<name>.git` */
  url: (name: string) => string
  close: () => Promise<void>
}

/**
 * Self-signed TLS material with SAN IP 127.0.0.1 for local git HTTPS.
 * @param dir - directory that receives openssl.cnf / key / cert.
 * @returns PEM key and cert.
 */
export async function generateSelfSignedTls(dir: string): Promise<{ key: string; cert: string }> {
  const cnf = join(dir, 'openssl.cnf')
  const keyPath = join(dir, 'key.pem')
  const certPath = join(dir, 'cert.pem')
  await writeFile(cnf, `[req]
distinguished_name = dn
x509_extensions = v3
prompt = no
[dn]
CN = localhost
[v3]
subjectAltName = DNS:localhost,IP:127.0.0.1
`)
  await execFileAsync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-sha256', '-days', '1', '-nodes',
    '-keyout', keyPath, '-out', certPath, '-config', cnf,
  ])
  return { key: await readFile(keyPath, 'utf8'), cert: await readFile(certPath, 'utf8') }
}

/**
 * Initialize a bare repo `{dir}/{name}.git` with a committed working tree.
 * @param dir - parent directory for work/ and the bare repo.
 * @param name - repo basename without `.git`.
 * @param files - relative path → utf8 contents, or `{ truncate: bytes }` for a sparse file.
 * @returns absolute path of the bare repo.
 */
export async function createBareRepo(
  dir: string,
  name: string,
  files: Record<string, string | { truncate: number }>,
): Promise<string> {
  const work = join(dir, `${name}-work`)
  const bare = join(dir, `${name}.git`)
  await mkdir(work, { recursive: true })
  await execFileAsync('git', ['init', '--bare', '-b', 'main', bare])
  await git(work, ['init', '-b', 'main'])
  await git(work, ['config', 'user.email', 'import@example.com'])
  await git(work, ['config', 'user.name', 'Import Fixture'])
  for (const [relative, body] of Object.entries(files)) {
    const full = join(work, relative)
    await mkdir(dirname(full), { recursive: true })
    if (typeof body === 'string') {
      await writeFile(full, body)
    } else {
      const handle = await open(full, 'w')
      await handle.truncate(body.truncate)
      await handle.close()
    }
  }
  await git(work, ['add', '.'])
  await git(work, ['commit', '-m', 'fixture'])
  await git(work, ['remote', 'add', 'origin', bare])
  await git(work, ['push', 'origin', 'HEAD:refs/heads/main'])
  await writeFile(join(bare, 'git-daemon-export-ok'), '')
  return bare
}

/**
 * Serve `root` (containing `*.git` bare repos) over HTTPS git smart HTTP.
 * @param options - TLS material, repo root, optional HTTP basic auth for the whole server.
 * @returns clone URL factory and closer.
 */
export async function listenGitHttps(options: {
  root: string
  key: string
  cert: string
  basicAuth?: { user: string; pass: string }
}): Promise<GitHttpsFixture> {
  const server = createServer({ key: options.key, cert: options.cert }, (req, res) => {
    handleGitHttp(req, res, options)
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const address = server.address()
  if (address === null || typeof address === 'string') {
    throw new Error('git HTTPS fixture has no port')
  }
  const base = `https://127.0.0.1:${String(address.port)}`
  return {
    url: name => `${base}/${name}.git`,
    close: () => new Promise((resolve, reject) => {
      server.close(error => error !== undefined ? reject(error) : resolve())
    }),
  }
}

function git(cwd: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync('git', args, { cwd, encoding: 'utf8' })
}

function handleGitHttp(
  req: IncomingMessage,
  res: ServerResponse,
  options: { root: string; basicAuth?: { user: string; pass: string } },
): void {
  if (options.basicAuth !== undefined) {
    const expected = `Basic ${Buffer.from(`${options.basicAuth.user}:${options.basicAuth.pass}`).toString('base64')}`
    if (req.headers.authorization !== expected) {
      res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="git"' })
      res.end()
      return
    }
  }
  const parsed = new URL(req.url ?? '/', 'https://127.0.0.1')
  const child = spawn('git', ['http-backend'], {
    env: {
      PATH: process.env['PATH'] ?? '/usr/bin:/bin',
      GIT_PROJECT_ROOT: options.root,
      GIT_HTTP_EXPORT_ALL: '1',
      PATH_INFO: parsed.pathname,
      QUERY_STRING: parsed.search.startsWith('?') ? parsed.search.slice(1) : '',
      REQUEST_METHOD: req.method ?? 'GET',
      CONTENT_TYPE: req.headers['content-type'] ?? '',
      CONTENT_LENGTH: req.headers['content-length'] ?? '0',
      REMOTE_ADDR: '127.0.0.1',
      REMOTE_USER: options.basicAuth?.user ?? '',
    },
  })
  child.stdin.on('error', () => undefined)
  if (req.method === 'POST') req.pipe(child.stdin)
  else child.stdin.end()

  let buf = Buffer.alloc(0)
  let headersSent = false
  child.stdout.on('data', (chunk: Buffer) => {
    if (headersSent) {
      res.write(chunk)
      return
    }
    buf = Buffer.concat([buf, chunk])
    let split = buf.indexOf('\r\n\r\n')
    let sep = 4
    if (split === -1) {
      split = buf.indexOf('\n\n')
      sep = 2
    }
    if (split === -1) return
    const headerText = buf.subarray(0, split).toString('utf8')
    const body = buf.subarray(split + sep)
    const headers: Record<string, string> = {}
    let status = 200
    for (const line of headerText.split(/\r?\n/)) {
      const idx = line.indexOf(':')
      if (idx <= 0) continue
      const name = line.slice(0, idx)
      const value = line.slice(idx + 1).trim()
      if (name.toLowerCase() === 'status') {
        const code = Number.parseInt(value, 10)
        if (!Number.isNaN(code)) status = code
      } else {
        headers[name] = value
      }
    }
    res.writeHead(status, headers)
    headersSent = true
    if (body.length > 0) res.write(body)
  })
  child.on('close', () => {
    if (!headersSent) res.writeHead(500)
    res.end()
  })
  child.on('error', () => {
    if (!headersSent) res.writeHead(500)
    res.end()
  })
}
