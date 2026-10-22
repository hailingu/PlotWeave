/** Generate exact-path coverage groups for the native canvas on the pinned Vitest5 provider. */
import { readdirSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

/** Discover production TypeScript recursively; tests and declaration-only files have no product runtime. */
function productionSources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) return productionSources(path)
    if (!entry.isFile() || !/\.tsx?$/.test(entry.name)) return []
    return /\.(?:test|spec)(?:-d)?\.tsx?$|\.d\.ts$/.test(entry.name)
      ? []
      : [path]
  })
}

/** Exact filenames must remain literal even when a source name contains glob metacharacters. */
function literalGlob(path: string): string {
  return Array.from(path, (character) =>
    '\\*?{}()[]!+@'.includes(character) ? '\\' + character : character,
  ).join('')
}

/** Each source owns one 80% group; new files are included at config resolution without changing global policy. */
export function nativeCanvasCoverageThresholds(
  repositoryRoot: string,
): Record<string, { lines: number }> {
  const directory = join(repositoryRoot, 'src/editor/nativeCanvas')
  return Object.fromEntries(
    productionSources(directory)
      .sort()
      .map((path) => [
        literalGlob(relative(repositoryRoot, path).split(sep).join('/')),
        { lines: 80 },
      ]),
  )
}
