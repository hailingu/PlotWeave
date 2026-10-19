/** Native App coverage accounting and the optional raw-count floor contract. */
import { describe, expect, it } from 'vitest'
import {
  nativeCoverageMinimum,
  nativeCoverageStatus,
  nativeCoverageSummary,
} from './native-coverage'

const root = '/checkout'
const path = 'native/macos/App/Service.swift'

/** App and test targets deliberately disagree so global/test percentages cannot masquerade as App. */
function report(coveredLines = 6, executableLines = 10) {
  return {
    coveredLines: 106,
    executableLines: 110,
    targets: [
      {
        name: 'PlotWeaveNative.app',
        files: [
          {
            path: root + '/' + path,
            coveredLines,
            executableLines,
            lineCoverage: 1,
          },
        ],
      },
      {
        name: 'PlotWeaveNativeTests.xctest',
        files: [
          { path: root + '/' + path, coveredLines: 100, executableLines: 100 },
        ],
      },
    ],
  }
}

it('counts only production App files and recomputes percentages from line counters', () => {
  const summary = nativeCoverageSummary(report(), root, [path])
  expect(summary).toMatchObject({
    coveredLines: 6,
    executableLines: 10,
    lineCoveragePercent: 60,
    reportedFileCount: 1,
    expectedFileCount: 1,
    unreportedFiles: [],
  })
})

it('lists compiler-unreported sources without inventing zero-line counters', () => {
  const missing = 'native/macos/App/Unreported.swift'
  const summary = nativeCoverageSummary(report(), root, [path, missing])
  expect(summary.files).toHaveLength(1)
  expect(summary.unreportedFiles).toEqual([missing])
  expect(nativeCoverageStatus(summary, null)).toBe('report-only')
  expect(nativeCoverageStatus(summary, 0)).toBe('incomplete')
})

it('accepts physical path aliases through the collection adapter', () => {
  const summary = nativeCoverageSummary(
    report(),
    '/physical',
    [path],
    (source) => source.replace(root, '/physical'),
  )
  expect(summary.coveredLines).toBe(6)
})

it('ignores generated files outside the production App tree', () => {
  const raw = report()
  raw.targets[0]?.files.push({
    path: root + '/native/macos/build/Generated.swift',
    coveredLines: 1000,
    executableLines: 1000,
    lineCoverage: 1,
  })
  expect(nativeCoverageSummary(raw, root, [path]).executableLines).toBe(10)
})

it.each([
  null,
  {},
  { targets: [] },
  { targets: [{ name: 'PlotWeaveNativeTests.xctest', files: [] }] },
])('rejects missing App reports: %j', (raw) => {
  expect(() => nativeCoverageSummary(raw, root, [path])).toThrow(
    '[NATIVE_COVERAGE_INVALID]',
  )
})

it.each([
  [-1, 10],
  [11, 10],
  [1.5, 10],
  [0, 0],
  [NaN, 10],
])('rejects invalid line counts %s/%s', (covered, executable) => {
  expect(() =>
    nativeCoverageSummary(report(covered, executable), root, [path]),
  ).toThrow('[NATIVE_COVERAGE_INVALID]')
})

it('rejects duplicate and stale App source records', () => {
  const raw = report()
  raw.targets[0]?.files.push({
    path: root + '/' + path,
    coveredLines: 6,
    executableLines: 10,
    lineCoverage: 1,
  })
  expect(() => nativeCoverageSummary(raw, root, [path])).toThrow(
    '[NATIVE_COVERAGE_INVALID]',
  )
  expect(() => nativeCoverageSummary(report(), root, [])).toThrow(
    '[NATIVE_COVERAGE_INVALID]',
  )
})

describe('optional floor', () => {
  it.each([undefined, '', '  '])(
    'is report-only for empty config %j',
    (value) => {
      expect(nativeCoverageMinimum(value)).toBeNull()
    },
  )
  it.each(['-1', '101', 'NaN', 'Infinity', '80x', '0x50'])(
    'rejects invalid config %s',
    (value) => {
      expect(() => nativeCoverageMinimum(value)).toThrow(
        '[NATIVE_COVERAGE_MIN_INVALID]',
      )
    },
  )
  it('passes equality and rejects a true ratio that rounds up to the displayed floor', () => {
    expect(nativeCoverageMinimum('80.5')).toBe(80.5)
    expect(
      nativeCoverageStatus(
        nativeCoverageSummary(report(80, 100), root, [path]),
        80,
      ),
    ).toBe('passed')
    expect(
      nativeCoverageStatus(
        nativeCoverageSummary(report(79995, 100000), root, [path]),
        80,
      ),
    ).toBe('below-minimum')
  })
})
