/** Retry classification and fail-closed contracts of the CI npm audit wrapper (issue #741, plan A). */
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { afterEach, expect, it } from 'vitest'

const script = resolve(import.meta.dirname, 'ci-npm-audit.sh')
const roots: string[] = []
const servers: Server[] = []
afterEach(async () => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise<void>((done) => server.close(() => done()))),
  )
})

/** One scripted answer to the bulk advisory POST; the last entry repeats. */
type BulkAnswer =
  { status: 500 } | { status: 200; severity?: 'high' | 'moderate' }

interface Registry {
  url: string
  bulkRequests: () => number
}

/** A real advisory as the bulk endpoint returns it: name → advisories matched by version range. */
function advisory(severity: 'high' | 'moderate') {
  return {
    id: 1673,
    url: 'https://github.com/advisories/GHSA-29mw-wpgm-hmr9',
    title: 'Fixture advisory',
    severity,
    vulnerable_versions: '<4.17.21',
    cwe_ids: ['CWE-77'],
  }
}

/** The packument npm fetches after a finding to compute fix availability. */
function packument(name: string) {
  const version = (v: string) => ({
    name,
    version: v,
    dist: { tarball: `http://127.0.0.1/${name}-${v}.tgz` },
  })
  return {
    name,
    'dist-tags': { latest: '4.17.21' },
    versions: { '4.17.20': version('4.17.20'), '4.17.21': version('4.17.21') },
  }
}

/** A loopback registry stub that answers the audit ping, bulk advisories and packuments. */
function startRegistry(plan: BulkAnswer[]): Promise<Registry> {
  const json = { 'content-type': 'application/json' }
  let bulkRequests = 0
  const server = createServer((request, response) => {
    request.resume()
    request.on('end', () => {
      const url = request.url ?? '/'
      if (
        request.method === 'POST' &&
        url.endsWith('/-/npm/v1/security/advisories/bulk')
      ) {
        const answer = plan[Math.min(bulkRequests, plan.length - 1)]!
        bulkRequests += 1
        if (answer.status === 500) {
          response.writeHead(500, json)
          response.end('{"error":"internal"}')
          return
        }
        response.writeHead(200, json)
        response.end(
          JSON.stringify(
            answer.severity ? { lodash: [advisory(answer.severity)] } : {},
          ),
        )
        return
      }
      response.writeHead(200, json)
      response.end(
        JSON.stringify(
          request.method === 'GET' && url === '/lodash'
            ? packument('lodash')
            : {},
        ),
      )
    })
  })
  servers.push(server)
  return new Promise((ready) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo
      ready({
        url: `http://127.0.0.1:${port}/`,
        bulkRequests: () => bulkRequests,
      })
    })
  })
}

/** A throwaway project whose lockfile pins a package the stub reports on; nothing is installed. */
function auditFixture(): string {
  const root = mkdtempSync(resolve(tmpdir(), 'plotweave-npm-audit-'))
  roots.push(root)
  const dependencies = { lodash: '4.17.20' }
  const manifest = { name: 'plotweave-audit-fixture', version: '1.0.0' }
  writeFileSync(
    resolve(root, 'package.json'),
    JSON.stringify({ ...manifest, dependencies }),
  )
  writeFileSync(
    resolve(root, 'package-lock.json'),
    JSON.stringify({
      ...manifest,
      lockfileVersion: 3,
      requires: true,
      packages: {
        '': { ...manifest, dependencies },
        'node_modules/lodash': { version: '4.17.20', license: 'MIT' },
      },
    }),
  )
  mkdirSync(resolve(root, 'npm-cache'))
  writeFileSync(resolve(root, 'npmrc'), '')
  return root
}

/** The wrapper's exit status and both output streams, as a completed child process. */
interface AuditRun {
  status: number | null
  stdout: string
  stderr: string
  output: string
}

/** Run the wrapper with real npm against the stub, isolated from the host's npm config, proxies and cache.
 * The stub serves from this test process, so the child must not block the event loop (no spawnSync). */
function runAudit(
  root: string,
  registry: Registry,
  overrides: Record<string, string> = {},
): Promise<AuditRun> {
  const env: Record<string, string | undefined> = { ...process.env }
  for (const key of Object.keys(env))
    if (/^https?_proxy$/i.test(key)) delete env[key]
  const child = spawn('sh', [script], {
    cwd: root,
    env: {
      ...env,
      npm_config_registry: registry.url,
      npm_config_cache: resolve(root, 'npm-cache'),
      npm_config_userconfig: resolve(root, 'npmrc'),
      npm_config_noproxy: '127.0.0.1',
      npm_config_update_notifier: 'false',
      npm_config_fund: 'false',
      PLOTWEAVE_AUDIT_RETRY_BASE_SECONDS: '0',
      ...overrides,
    },
  })
  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
    stdout += chunk
  })
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
    stderr += chunk
  })
  return new Promise((done) => {
    const timer = setTimeout(() => child.kill('SIGKILL'), 100_000)
    child.on('close', (status) => {
      clearTimeout(timer)
      done({ status, stdout, stderr, output: `${stdout}${stderr}` })
    })
  })
}

const retryDelays = (output: string) =>
  [...output.matchAll(/\[NPM_AUDIT_RETRY\][^\n]*retrying in (\d+)s/g)].map(
    (match) => Number(match[1]),
  )

it('passes on the first attempt when the registry reports no advisories', async () => {
  const registry = await startRegistry([{ status: 200 }])
  const result = await runAudit(auditFixture(), registry)
  expect(result.status).toBe(0)
  expect(registry.bulkRequests()).toBe(1)
  expect(result.output).not.toContain('[NPM_AUDIT_RETRY]')
}, 120_000)

it('blocks immediately without retrying when a high advisory is reported', async () => {
  const registry = await startRegistry([{ status: 200, severity: 'high' }])
  const result = await runAudit(auditFixture(), registry)
  expect(result.status).toBe(1)
  expect(registry.bulkRequests()).toBe(1)
  expect(result.output).not.toContain('[NPM_AUDIT_RETRY]')
  expect(result.output).not.toContain('[NPM_AUDIT_EXHAUSTED]')
}, 120_000)

it('keeps the high audit level: a moderate advisory alone does not block', async () => {
  const registry = await startRegistry([{ status: 200, severity: 'moderate' }])
  const result = await runAudit(auditFixture(), registry)
  expect(result.status).toBe(0)
  expect(registry.bulkRequests()).toBe(1)
}, 120_000)

it('retries transient endpoint failures with doubling delays and passes once the endpoint recovers', async () => {
  const registry = await startRegistry([
    { status: 500 },
    { status: 500 },
    { status: 200 },
  ])
  const result = await runAudit(auditFixture(), registry, {
    PLOTWEAVE_AUDIT_RETRY_BASE_SECONDS: '1',
  })
  expect(result.status).toBe(0)
  expect(registry.bulkRequests()).toBe(3)
  expect(retryDelays(result.output)).toEqual([1, 2])
  expect(result.output).not.toContain('[NPM_AUDIT_EXHAUSTED]')
}, 120_000)

it('fails closed after the default retry budget when the endpoint keeps failing', async () => {
  const registry = await startRegistry([{ status: 500 }])
  const result = await runAudit(auditFixture(), registry)
  expect(result.status).toBe(1)
  expect(registry.bulkRequests()).toBe(4)
  expect(retryDelays(result.output)).toHaveLength(3)
  expect(result.stderr).toMatch(/^::error::\[NPM_AUDIT_EXHAUSTED\]/m)
}, 120_000)

it('honours a smaller PLOTWEAVE_AUDIT_MAX_ATTEMPTS budget', async () => {
  const registry = await startRegistry([{ status: 500 }])
  const result = await runAudit(auditFixture(), registry, {
    PLOTWEAVE_AUDIT_MAX_ATTEMPTS: '2',
  })
  expect(result.status).toBe(1)
  expect(registry.bulkRequests()).toBe(2)
  expect(result.stderr).toMatch(/^::error::\[NPM_AUDIT_EXHAUSTED\]/m)
}, 120_000)

it('rejects a malformed retry budget before running any audit', async () => {
  const registry = await startRegistry([{ status: 200 }])
  const result = await runAudit(auditFixture(), registry, {
    PLOTWEAVE_AUDIT_MAX_ATTEMPTS: 'three',
  })
  expect(result.status).toBe(2)
  expect(registry.bulkRequests()).toBe(0)
  expect(result.stderr).toMatch(/^::error::\[NPM_AUDIT_CONFIG\]/m)
}, 120_000)
