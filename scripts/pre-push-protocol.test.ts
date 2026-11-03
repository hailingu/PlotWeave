/** Exercise the extracted scope protocol through its real POSIX shell interface (#948). */
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { afterEach, expect, it } from 'vitest'

const protocol = resolve(import.meta.dirname, 'pre-push-protocol.sh')
const directories: string[] = []

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

/** Each invocation owns an independent manifest; only the requested commit contributes scope. */
function aggregate(lines: string[], commit = 'target') {
  const directory = mkdtempSync(resolve(tmpdir(), 'plotweave-push-protocol-'))
  directories.push(directory)
  const manifest = resolve(directory, 'scopes')
  writeFileSync(manifest, lines.join('\n') + '\n')
  return spawnSync(
    '/bin/sh',
    [
      '-c',
      '. "$1"; scope_manifest_path=$2; aggregate_commit_scope "$3"',
      'push-protocol-unit',
      protocol,
      manifest,
      commit,
    ],
    { encoding: 'utf8', timeout: 2_000 },
  )
}

it.each([
  { name: 'empty input', lines: [], scope: 'docs' },
  { name: 'docs only', lines: ['target docs ref-a'], scope: 'docs' },
  {
    name: 'same stack repeated',
    lines: ['target native ref-a', 'target native ref-b'],
    scope: 'native',
  },
  {
    name: 'docs before frontend',
    lines: ['target docs ref-a', 'target frontend ref-b'],
    scope: 'frontend',
  },
  {
    name: 'docs after rust',
    lines: ['target rust ref-a', 'target docs ref-b'],
    scope: 'rust',
  },
  {
    name: 'different stacks',
    lines: ['target frontend ref-a', 'target rust ref-b'],
    scope: 'full',
  },
  {
    name: 'reverse stack order',
    lines: ['target rust ref-b', 'target frontend ref-a'],
    scope: 'full',
  },
  {
    name: 'full remains absorbing',
    lines: ['target full ref-a', 'target native ref-b', 'target docs ref-c'],
    scope: 'full',
  },
  {
    name: 'other commit ignored',
    lines: ['other full ref-a', 'target native ref-b'],
    scope: 'native',
  },
])('aggregates the scope protocol: $name', ({ lines, scope }) => {
  const result = aggregate(lines)
  expect(result.error).toBeUndefined()
  expect(result.status, result.stderr).toBe(0)
  expect(result.stdout.trim()).toBe(scope)
})
