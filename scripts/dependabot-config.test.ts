/** Dependabot must update both Cargo resolvers within the existing weekly batch. */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { expect, it } from 'vitest'

interface Update {
  'package-ecosystem': string
  [key: string]: unknown
}

/** Parse configuration data with the existing locked YAML parser. */
const { load } = createRequire(import.meta.url)('js-yaml') as {
  load: (source: string) => { version: number; updates: Update[] }
}
const configuration = load(
  readFileSync(
    resolve(import.meta.dirname, '../.github/dependabot.yml'),
    'utf8',
  ),
)
const weeklyPolicy = {
  'target-branch': 'dev',
  schedule: { interval: 'weekly', day: 'monday', timezone: 'Asia/Shanghai' },
  'open-pull-requests-limit': 5,
}

it('keeps both Cargo workspaces in one minor/patch update group', () => {
  expect(configuration.version).toBe(2)
  expect(
    configuration.updates.filter(
      (entry) => entry['package-ecosystem'] === 'cargo',
    ),
  ).toEqual([
    {
      'package-ecosystem': 'cargo',
      directories: ['/src-tauri', '/crates'],
      ...weeklyPolicy,
      groups: {
        'cargo-minor-and-patch': { 'update-types': ['minor', 'patch'] },
      },
    },
  ])
})

it('retains npm and Actions update policies without adding another ecosystem', () => {
  expect(
    configuration.updates.filter(
      (entry) => entry['package-ecosystem'] !== 'cargo',
    ),
  ).toEqual([
    {
      'package-ecosystem': 'npm',
      directory: '/',
      ...weeklyPolicy,
      groups: { 'npm-minor-and-patch': { 'update-types': ['minor', 'patch'] } },
    },
    { 'package-ecosystem': 'github-actions', directory: '/', ...weeklyPolicy },
  ])
})
