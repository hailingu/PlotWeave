/** Coverage policy discovery must include new production modules without admitting test fixtures. */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { nativeCanvasCoverageThresholds } from './native-canvas-coverage'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

/** An exclusively owned tree makes source inventory changes observable at the public config boundary. */
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'plotweave-file-floor-'))
  roots.push(root)
  const add = (name: string) => {
    const path = join(root, 'src/editor/nativeCanvas', name)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, 'export const value = 1\n')
  }
  return { root, add }
}

it('assigns independent 80 floors to nested TS/TSX sources while ignoring tests and declarations', () => {
  const { root, add } = fixture()
  for (const name of [
    'View.tsx',
    'nested/handler.ts',
    'handler.test.ts',
    'View.test.tsx',
    'handler.spec.ts',
    'probe.test-d.ts',
    'contract.d.ts',
    'style.css',
  ])
    add(name)
  expect(nativeCanvasCoverageThresholds(root)).toEqual({
    'src/editor/nativeCanvas/View.tsx': { lines: 80 },
    'src/editor/nativeCanvas/nested/handler.ts': { lines: 80 },
  })
  add('NewModule.ts')
  expect(
    nativeCanvasCoverageThresholds(root)[
      'src/editor/nativeCanvas/NewModule.ts'
    ],
  ).toEqual({ lines: 80 })
})

it('escapes glob metacharacters so a filename cannot widen its coverage group', () => {
  const { root, add } = fixture()
  add('literal[1].tsx')
  expect(nativeCanvasCoverageThresholds(root)).toEqual({
    'src/editor/nativeCanvas/literal\\[1\\].tsx': { lines: 80 },
  })
})

it('fails closed when the production source directory is unavailable', () => {
  const { root } = fixture()
  expect(() => nativeCanvasCoverageThresholds(root)).toThrow()
})
