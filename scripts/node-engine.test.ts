/** The advertised Node range must agree with the locked toolchain's install requirements. */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { expect, it } from 'vitest'

// Reuse the locked parser's semver dependency without introducing another package.
const require = createRequire(import.meta.url)
const { satisfies } = createRequire(
  require.resolve('@typescript-eslint/typescript-estree'),
)('semver') as {
  satisfies: (version: string, range: string) => boolean
}
const root = resolve(import.meta.dirname, '..')
const manifest = JSON.parse(
  readFileSync(resolve(root, 'package.json'), 'utf8'),
) as {
  engines: { node: string }
}
const lock = JSON.parse(
  readFileSync(resolve(root, 'package-lock.json'), 'utf8'),
) as {
  packages: Record<string, { engines?: { node?: string } }>
}

it.each([
  ['24.17.0', false],
  ['24.18.0', true],
  ['24.19.0', true],
  ['25.0.0', false],
  ['25.99.0', false],
  ['26.0.0', true],
  ['28.0.0', true],
])('advertises Node %s support as %s', (version, supported) => {
  expect(satisfies(version, manifest.engines.node)).toBe(supported)
  if (!supported) return
  for (const [name, entry] of Object.entries(lock.packages)) {
    if (entry.engines?.node)
      expect(satisfies(version, entry.engines.node), name).toBe(true)
  }
})

it('keeps the lock root and reproducible Node pin inside the advertised range', () => {
  expect(lock.packages['']?.engines?.node).toBe(manifest.engines.node)
  const pinned = readFileSync(resolve(root, '.nvmrc'), 'utf8').trim()
  expect(satisfies(pinned, manifest.engines.node)).toBe(true)
})
