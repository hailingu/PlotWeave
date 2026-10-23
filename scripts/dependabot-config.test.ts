/** Dependabot must keep paired npm dependencies and both Cargo resolvers in coherent review units. */
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
      groups: {
        'react-family': {
          patterns: ['react', 'react-dom', '@types/react', '@types/react-dom'],
        },
        'vite-family': { patterns: ['vite', '@vitejs/plugin-react'] },
        'vitest-family': { patterns: ['vitest', '@vitest/coverage-v8'] },
        'npm-minor-and-patch': { 'update-types': ['minor', 'patch'] },
      },
    },
    { 'package-ecosystem': 'github-actions', directory: '/', ...weeklyPolicy },
  ])
})

it('routes paired packages before the general minor/patch group for every update level', () => {
  const npm = configuration.updates.find(
    (entry) => entry['package-ecosystem'] === 'npm',
  )
  const groups = npm?.groups as Record<
    string,
    { patterns?: string[]; 'update-types'?: string[] }
  >
  for (const [family, packages] of Object.entries({
    'react-family': ['react', 'react-dom', '@types/react', '@types/react-dom'],
    'vite-family': ['vite', '@vitejs/plugin-react'],
    'vitest-family': ['vitest', '@vitest/coverage-v8'],
  })) {
    for (const name of packages) {
      for (const level of ['major', 'minor', 'patch']) {
        const match = Object.entries(groups).find(
          ([, rule]) =>
            (!rule.patterns || rule.patterns.includes(name)) &&
            (!rule['update-types'] || rule['update-types'].includes(level)),
        )
        expect(match?.[0], `${name} ${level}`).toBe(family)
      }
    }
  }
})
