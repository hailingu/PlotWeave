/** Test-only source inventory and xccov tool fixture for the real Git-gate script chain. */
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

/** Seed one tracked App source before fixture history is created, including slow-path refs. */
export function writeNativeCoverageSource(root: string): void {
  const path = resolve(root, 'native/macos/App/CoverageFixture.swift')
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(
    path,
    '/// Isolated gate fixture.\nenum CoverageFixture { static let value = 1 }\n',
  )
}

/** xccov reports the actual fixture checkout paths, including temporary Git worktrees. */
export function writeXccovStub(path: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(
    path,
    `#!${process.execPath}\n` +
      String.raw`
const fs = require('node:fs');
const path = require('node:path');
const directory = path.resolve(process.cwd(), 'native/macos/App');
const files = fs.readdirSync(directory, { recursive: true })
  .filter(file => typeof file === 'string' && file.endsWith('.swift'))
  .map(file => ({ path: path.join(directory, file), coveredLines: 1, executableLines: 1 }));
process.stdout.write(JSON.stringify({ targets: [{ name: 'PlotWeaveNative.app', files }] }));
`,
  )
  chmodSync(path, 0o755)
}
