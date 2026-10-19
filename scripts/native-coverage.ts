/** Xcode xccov adapter: report App Swift line counts without counting tests or hiding missing sources. */
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const APP_DIRECTORY = 'native/macos/App'
const APP_TARGET = 'PlotWeaveNative.app'

/** Executable line counters reported for one production source file. */
export interface NativeFileCoverage {
  readonly path: string
  readonly coveredLines: number
  readonly executableLines: number
}

/** Measured counters and a separate source inventory; unreported files never become fake 0/0 rows. */
export interface NativeCoverageSummary {
  readonly formatVersion: 1
  readonly scope: string
  readonly files: readonly NativeFileCoverage[]
  readonly coveredLines: number
  readonly executableLines: number
  readonly lineCoveragePercent: number
  readonly reportedFileCount: number
  readonly expectedFileCount: number
  readonly unreportedFiles: readonly string[]
}

/** Reject malformed collection data with a stable diagnostic rather than an empty success. */
function invalid(reason: string): never {
  throw new Error(`[NATIVE_COVERAGE_INVALID] ${reason}`)
}

/** JSON records must be objects, not null or arrays. */
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** xccov counters are nonnegative, exact integers. */
function counter(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
    return invalid('Invalid line counter')
  return value
}

/** Use raw file counts for the app target; the path adapter handles physical checkout aliases. */
export function nativeCoverageSummary(
  raw: unknown,
  repositoryRoot: string,
  expectedFiles: readonly string[],
  sourcePath: (path: string) => string = resolve,
): NativeCoverageSummary {
  if (!record(raw) || !Array.isArray(raw.targets))
    return invalid('Missing targets')
  const targets: unknown[] = raw.targets
  const apps = targets
    .filter(record)
    .filter((target) => target.name === APP_TARGET)
  const app = apps[0]
  if (apps.length !== 1 || !app || !Array.isArray(app.files))
    return invalid('Missing or ambiguous app target')
  const expected = new Set(expectedFiles)
  const seen = new Set<string>()
  const files: NativeFileCoverage[] = []
  const entries: unknown[] = app.files
  for (const entry of entries) {
    if (!record(entry) || typeof entry.path !== 'string')
      return invalid('Invalid source entry')
    const path = relative(repositoryRoot, sourcePath(entry.path))
      .split(sep)
      .join('/')
    if (!path.startsWith(APP_DIRECTORY + '/') || !path.endsWith('.swift'))
      continue
    if (!expected.has(path) || seen.has(path))
      return invalid('Unknown or duplicate App source: ' + path)
    const coveredLines = counter(entry.coveredLines)
    const executableLines = counter(entry.executableLines)
    if (coveredLines > executableLines)
      return invalid('Covered lines exceed executable lines')
    seen.add(path)
    files.push({ path, coveredLines, executableLines })
  }
  const coveredLines = files.reduce((sum, file) => sum + file.coveredLines, 0)
  const executableLines = files.reduce(
    (sum, file) => sum + file.executableLines,
    0,
  )
  if (!Number.isSafeInteger(executableLines) || executableLines === 0)
    return invalid('No measurable App lines')
  return {
    formatVersion: 1,
    scope: APP_DIRECTORY + '/**/*.swift',
    files: files.sort((a, b) => a.path.localeCompare(b.path)),
    coveredLines,
    executableLines,
    lineCoveragePercent: (coveredLines / executableLines) * 100,
    reportedFileCount: files.length,
    expectedFileCount: expected.size,
    unreportedFiles: [...expected].filter((path) => !seen.has(path)).sort(),
  }
}

/** Empty configuration selects the initial report-only policy; numeric bounds are explicit. */
export function nativeCoverageMinimum(
  value: string | undefined,
): number | null {
  if (value === undefined || value.trim() === '') return null
  const text = value.trim()
  const minimum = Number(text)
  if (
    !/^\d+(\.\d+)?$/.test(text) ||
    !Number.isFinite(minimum) ||
    minimum < 0 ||
    minimum > 100
  ) {
    throw new Error(
      '[NATIVE_COVERAGE_MIN_INVALID] Expected a percentage from 0 to 100',
    )
  }
  return minimum
}

/** An opted-in floor cannot pass with incomplete inventory or a rounded-up percentage. */
export function nativeCoverageStatus(
  summary: NativeCoverageSummary,
  minimum: number | null,
): 'report-only' | 'incomplete' | 'passed' | 'below-minimum' {
  if (minimum === null) return 'report-only'
  if (summary.unreportedFiles.length > 0) return 'incomplete'
  return summary.coveredLines * 100 >= minimum * summary.executableLines
    ? 'passed'
    : 'below-minimum'
}

/** Render relative file counters and visibly distinguish sources absent from the compiler report. */
export function nativeCoverageMarkdown(
  summary: NativeCoverageSummary,
  minimum: number | null,
): string {
  const cell = (path: string) =>
    path.replaceAll('|', '\\|').replaceAll('\n', ' ')
  const rows = summary.files.map(
    (file) =>
      `| ${cell(file.path)} | ${file.coveredLines}/${file.executableLines} | ${file.executableLines ? ((file.coveredLines / file.executableLines) * 100).toFixed(2) + '%' : 'no executable lines'} |`,
  )
  const missing = summary.unreportedFiles.map(
    (path) => `| ${cell(path)} | not reported | unavailable |`,
  )
  return [
    '## Swift App line coverage',
    '',
    `Reported App files: **${summary.coveredLines}/${summary.executableLines} lines (${summary.lineCoveragePercent.toFixed(2)}%)**.`,
    `Source inventory: ${summary.reportedFileCount}/${summary.expectedFileCount} files reported; ${summary.unreportedFiles.length} unavailable.`,
    `Minimum: ${minimum === null ? 'report-only (no default floor)' : minimum + '%'}; status: ${nativeCoverageStatus(summary, minimum)}.`,
    'Tests, generated sources outside App/, and WebKit process JavaScript are outside this metric.',
    '',
    '| Production Swift file | Covered/executable lines | Coverage |',
    '| --- | ---: | ---: |',
    ...missing,
    ...rows,
    '',
  ].join('\n')
}

/** Inventory the actual App tree; no caller-controlled source exclusions are accepted. */
function appSources(
  root: string,
  directory = join(root, APP_DIRECTORY),
): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) return appSources(root, path)
    return entry.isFile() && path.endsWith('.swift')
      ? [relative(root, path).split(sep).join('/')]
      : []
  })
}

/** Collect fresh xccov data, retain reports even on a requested floor failure, and publish CI summary. */
function runReport(args: readonly string[]): number {
  const [input, rootArgument, output, minimumArgument] = args
  if (
    args.length < 3 ||
    args.length > 4 ||
    !input ||
    !rootArgument ||
    !output
  ) {
    return invalid(
      'Usage: native-coverage.ts input.json repository-root output-directory [minimum]',
    )
  }
  const minimum = nativeCoverageMinimum(minimumArgument)
  const root = realpathSync(rootArgument)
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(input, 'utf8'))
  } catch {
    return invalid('Cannot read xccov JSON')
  }
  const summary = nativeCoverageSummary(raw, root, appSources(root), (path) =>
    existsSync(path) ? realpathSync(path) : resolve(path),
  )
  const status = nativeCoverageStatus(summary, minimum)
  const markdown = nativeCoverageMarkdown(summary, minimum)
  mkdirSync(output, { recursive: true })
  writeFileSync(
    join(output, 'coverage-summary.json'),
    JSON.stringify(
      {
        ...summary,
        generatedAt: new Date().toISOString(),
        minimumLineCoveragePercent: minimum,
        status,
      },
      null,
      2,
    ) + '\n',
  )
  writeFileSync(join(output, 'coverage-summary.md'), markdown)
  writeFileSync(join(output, 'xccov.json'), JSON.stringify(raw, null, 2) + '\n')
  if (process.env.GITHUB_STEP_SUMMARY)
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdown)
  console.log(
    `[NATIVE_COVERAGE_REPORT] ${summary.coveredLines}/${summary.executableLines} lines (${summary.lineCoveragePercent.toFixed(2)}%); files ${summary.reportedFileCount}/${summary.expectedFileCount}; ${status}`,
  )
  if (summary.unreportedFiles.length > 0)
    console.log(
      '[NATIVE_COVERAGE_UNREPORTED] ' + summary.unreportedFiles.join(', '),
    )
  if (status === 'incomplete' || status === 'below-minimum') {
    console.error(`[NATIVE_COVERAGE_MIN_FAILED] ${status}; minimum=${minimum}%`)
    return 1
  }
  return 0
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    process.exitCode = runReport(process.argv.slice(2))
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
