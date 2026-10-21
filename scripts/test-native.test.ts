/** Native entry selection, fresh App coverage collection and failure propagation contracts. */
import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { afterEach, expect, it } from 'vitest'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

/** Tool failures and optional threshold inputs remain isolated from the host environment. */
interface NativeOptions {
  mode?: string
  npmExit?: number
  xcodeExit?: number
  xccovExit?: number
  rawReport?: unknown
  xccovOutput?: string
  staleSummary?: boolean
  minimum?: string
  budget?: string
  pathNodeExit?: number
}

/** A real source inventory with synthetic xccov output at the external tool boundary. */
function nativeFixture() {
  const root = mkdtempSync(resolve(tmpdir(), 'plotweave-native-entry-'))
  roots.push(root)
  const app = resolve(root, 'native/macos/App')
  mkdirSync(app, { recursive: true })
  const path = resolve(app, 'Fixture.swift')
  writeFileSync(path, 'func fixture() {}\n')
  const report = {
    targets: [
      {
        name: 'PlotWeaveNative.app',
        files: [{ path, coveredLines: 6, executableLines: 10 }],
      },
      {
        name: 'PlotWeaveNativeTests.xctest',
        files: [
          {
            path: resolve(root, 'native/macos/Tests/Test.swift'),
            coveredLines: 100,
            executableLines: 100,
          },
        ],
      },
    ],
  }
  const log = resolve(root, 'calls.jsonl')
  writeFileSync(log, '')
  return { root, report, log }
}

/** Record argv and produce controlled tool output without running a build or Xcode. */
function nativeTool(
  root: string,
  log: string,
  name: string,
  status: number,
  output = '',
) {
  const path = resolve(root, name)
  writeFileSync(
    path,
    `#!${process.execPath}\n` +
      `require('node:fs').appendFileSync(${JSON.stringify(log)}, JSON.stringify({tool:${JSON.stringify(name)},args:process.argv.slice(2),stress:process.env.TEST_RUNNER_PLOTWEAVE_NATIVE_STRESS_TESTS})+'\\n');process.stdout.write(${JSON.stringify(output)});process.exit(${status})\n`,
  )
  chmodSync(path, 0o755)
  return path
}

/** Exercise the real shell entry and report adapter in an exclusively owned repository fixture. */
function runNative(options: NativeOptions = {}) {
  const { root, report, log } = nativeFixture()
  if (options.staleSummary) {
    const directory = resolve(root, 'native/macos/build/coverage')
    mkdirSync(directory, { recursive: true })
    writeFileSync(resolve(directory, 'coverage-summary.json'), '{"stale":true}')
  }
  if (options.pathNodeExit !== undefined)
    nativeTool(root, log, 'node', options.pathNodeExit)
  const result = spawnSync(
    'sh',
    [
      resolve(import.meta.dirname, 'test-native.sh'),
      ...(options.mode ? [options.mode] : []),
    ],
    {
      encoding: 'utf8',
      timeout: 10000,
      env: {
        ...process.env,
        PLOTWEAVE_NODE_BIN: process.execPath,
        PATH:
          options.pathNodeExit === undefined
            ? process.env.PATH
            : `${root}:${process.env.PATH ?? ''}`,
        PLOTWEAVE_GATE_REPOSITORY_ROOT: root,
        PLOTWEAVE_GATE_CPU_BUDGET: options.budget ?? '4',
        TEST_RUNNER_PLOTWEAVE_NATIVE_STRESS_TESTS:
          options.mode === 'stress' ? '0' : '1',
        PLOTWEAVE_NATIVE_MIN_LINE_COVERAGE: options.minimum ?? '',
        GITHUB_STEP_SUMMARY: resolve(root, 'step-summary.md'),
        PLOTWEAVE_NPM_BIN: nativeTool(root, log, 'npm', options.npmExit ?? 0),
        PLOTWEAVE_XCODEBUILD_BIN: nativeTool(
          root,
          log,
          'xcodebuild',
          options.xcodeExit ?? 0,
        ),
        PLOTWEAVE_XCRUN_BIN: nativeTool(
          root,
          log,
          'xcrun',
          options.xccovExit ?? 0,
          options.xccovOutput ??
            JSON.stringify(
              options.rawReport === undefined ? report : options.rawReport,
            ),
        ),
      },
    },
  )
  const calls = readFileSync(log, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map(
      (line) =>
        JSON.parse(line) as { tool: string; args: string[]; stress: string },
    )
  const summaryPath = resolve(
    root,
    'native/macos/build/coverage/coverage-summary.json',
  )
  const summary = existsSync(summaryPath)
    ? JSON.parse(readFileSync(summaryPath, 'utf8'))
    : null
  return { ...result, calls, root, summary }
}

it('默认保留功能回归，开启 App 覆盖率并关闭压力测量', () => {
  const result = runNative()
  expect(result.status, result.stderr).toBe(0)
  expect(result.calls[0]).toMatchObject({
    tool: 'npm',
    args: ['run', 'build:native-canvas'],
  })
  const args = result.calls[1]?.args ?? []
  expect(result.calls[1]?.stress).toBe('0')
  expect(args.some((arg) => arg.startsWith('-only-testing'))).toBe(false)
  expect(args.some((arg) => arg.startsWith('-skip-testing'))).toBe(false)
  expect(args.slice(-3)).toEqual(['-parallel-testing-enabled', 'NO', 'test'])
  expect(args[args.indexOf('-enableCodeCoverage') + 1]).toBe('YES')
  expect(args[args.indexOf('-jobs') + 1]).toBe('4')
  expect(result.calls.map((call) => call.tool)).toEqual([
    'npm',
    'xcodebuild',
    'xcrun',
  ])
  expect(result.calls[2]?.args.slice(0, 4)).toEqual([
    'xccov',
    'view',
    '--report',
    '--json',
  ])
  expect(result.summary).toMatchObject({
    coveredLines: 6,
    executableLines: 10,
    minimumLineCoveragePercent: null,
  })
  expect(existsSync(resolve(result.root, 'step-summary.md'))).toBe(true)
})

it('stress 显式开启原规模测量，关闭覆盖率且不采集报告', () => {
  const result = runNative({ mode: 'stress' })
  expect(result.status, result.stderr).toBe(0)
  const args = result.calls[1]?.args ?? []
  expect(result.calls[1]?.stress).toBe('1')
  expect(args.filter((arg) => arg.startsWith('-only-testing:'))).toEqual([
    '-only-testing:PlotWeaveNativeTests/WebCanvasPerformanceTests',
    '-only-testing:PlotWeaveNativeTests/WebCanvasFirstDragLatencyTests/sameNodeFirstAndSecondDragRecordStartupEvidence()',
  ])
  expect(args[args.indexOf('-enableCodeCoverage') + 1]).toBe('NO')
  expect(result.calls).toHaveLength(2)
  expect(result.summary).toBeNull()
})

it('first-drag 仅启用首拖套件，不运行大图或长循环且不采覆盖率', () => {
  const result = runNative({ mode: 'first-drag' })
  expect(result.status).toBe(0)
  expect(result.calls.map((call) => call.tool)).toEqual(['npm', 'xcodebuild'])
  expect(result.calls[1]?.stress).toBe('1')
  const args = result.calls[1]?.args ?? []
  expect(args).toContain(
    '-only-testing:PlotWeaveNativeTests/WebCanvasFirstDragLatencyTests',
  )
  expect(args.filter((arg) => arg.startsWith('-only-testing:'))).toHaveLength(1)
  expect(args).not.toContain(
    '-only-testing:PlotWeaveNativeTests/WebCanvasPerformanceTests',
  )
  expect(
    args.slice(
      args.indexOf('-enableCodeCoverage'),
      args.indexOf('-enableCodeCoverage') + 2,
    ),
  ).toEqual(['-enableCodeCoverage', 'NO'])
  expect(result.summary).toBeNull()
})

it('first-drag 透传构建与首拖失败，不转成默认回归或成功', () => {
  for (const options of [{ npmExit: 23 }, { xcodeExit: 29 }]) {
    const result = runNative({ mode: 'first-drag', ...options })
    expect(result.status).toBe(options.npmExit ?? options.xcodeExit)
    expect(result.summary).toBeNull()
    expect(result.calls.some((call) => call.tool === 'xcrun')).toBe(false)
  }
})

it.each([
  [23, 0, 1],
  [0, 65, 2],
])('构建状态 %i / 测试状态 %i 透传失败', (npmExit, xcodeExit, calls) => {
  const result = runNative({ npmExit, xcodeExit })
  expect(result.status).toBe(npmExit || xcodeExit)
  expect(result.calls).toHaveLength(calls)
  expect(result.summary).toBeNull()
})

it('xccov 失败阻断，不产生成功摘要', () => {
  const result = runNative({ xccovExit: 47 })
  expect(result.status).toBe(47)
  expect(result.summary).toBeNull()
})

it('坏覆盖率数据阻断，不用测试 bundle 伪装 App 指标', () => {
  const result = runNative({
    rawReport: {
      targets: [{ name: 'PlotWeaveNativeTests.xctest', files: [] }],
    },
  })
  expect(result.status).not.toBe(0)
  expect(result.stderr).toContain('[NATIVE_COVERAGE_INVALID]')
  expect(result.summary).toBeNull()
})

it.each([
  ['60', 0],
  ['60.01', 1],
])('显式下限 %s：摘要保留且状态为 %i', (minimum, status) => {
  const result = runNative({ minimum })
  expect(result.status, result.stderr).toBe(status)
  expect(result.summary).toMatchObject({
    coveredLines: 6,
    executableLines: 10,
    minimumLineCoveragePercent: Number(minimum),
  })
})

it('未知模式在启动构建前失败', () => {
  const result = runNative({ mode: 'invalid' })
  expect(result.status).toBe(2)
  expect(result.calls).toEqual([])
})

it('非法 CPU 预算在构建前失败', () => {
  const result = runNative({ budget: '0' })
  expect(result.status).toBe(2)
  expect(result.calls).toEqual([])
})

it('malformed xccov JSON fails collection', () => {
  const result = runNative({ xccovOutput: '{broken' })
  expect(result.status).toBe(1)
  expect(result.stderr).toContain('[NATIVE_COVERAGE_INVALID]')
  expect(result.summary).toBeNull()
})

it('a failed new build invalidates the previously published summary', () => {
  const result = runNative({ npmExit: 23, staleSummary: true })
  expect(result.status).toBe(23)
  expect(result.summary).toBeNull()
})

it('uses the configured Node even when PATH resolves to an incompatible executable', () => {
  const result = runNative({ pathNodeExit: 97 })
  expect(result.status, result.stderr).toBe(0)
  expect(result.calls.map((call) => call.tool)).toEqual([
    'npm',
    'xcodebuild',
    'xcrun',
  ])
  expect(result.summary).toMatchObject({ coveredLines: 6, executableLines: 10 })
})
