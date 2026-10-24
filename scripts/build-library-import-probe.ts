/** Builds a disposable test-only IIFE from the production import facade; never enters shipped resources. */
import { build } from 'vite'
import { mkdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const directory = new URL('../native/macos/build/', import.meta.url)
const result = await build({
  configFile: false,
  root,
  logLevel: 'error',
  build: {
    write: false,
    minify: false,
    lib: {
      entry: 'scripts/fixtures/library-import-probe.ts',
      name: 'PlotWeaveLibraryProbe',
      formats: ['iife'],
    },
  },
})
const outputs = Array.isArray(result) ? result : [result]
const chunk = outputs
  .flatMap((output) => ('output' in output ? output.output : []))
  .find((entry) => entry.type === 'chunk')
if (!chunk || chunk.type !== 'chunk')
  throw new Error('PW_LIBRARY_PROBE_BUILD_MISSING')
await mkdir(directory, { recursive: true })
await writeFile(new URL('library-import-probe.js', directory), chunk.code)
