/** 验证原生测试入口的选择及退出码契约；实际 Swift 标识由 Xcode 枚举复核。 */
import { spawnSync } from 'node:child_process'
import {
  chmodSync,
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

/** 只替换构建工具边界，执行真实入口并记录结构化 argv。 */
function runNative(mode?: string, npmExit = 0, xcodeExit = 0) {
  const root = mkdtempSync(resolve(tmpdir(), 'plotweave-native-entry-'))
  roots.push(root)
  const log = resolve(root, 'calls.jsonl')
  writeFileSync(log, '')
  const tool = (name: string, status: number) => {
    const path = resolve(root, name)
    writeFileSync(
      path,
      `#!${process.execPath}\n` +
        `require('node:fs').appendFileSync(${JSON.stringify(log)}, JSON.stringify({tool: ${JSON.stringify(name)}, args: process.argv.slice(2), stress: process.env.TEST_RUNNER_PLOTWEAVE_NATIVE_STRESS_TESTS}) + '\\n'); process.exit(${status})\n`,
    )
    chmodSync(path, 0o755)
    return path
  }
  const result = spawnSync(
    'sh',
    [resolve(import.meta.dirname, 'test-native.sh'), ...(mode ? [mode] : [])],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        TEST_RUNNER_PLOTWEAVE_NATIVE_STRESS_TESTS:
          mode === 'stress' ? '0' : '1',
        PLOTWEAVE_NPM_BIN: tool('npm', npmExit),
        PLOTWEAVE_XCODEBUILD_BIN: tool('xcodebuild', xcodeExit),
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
  return { ...result, calls }
}

it('默认保留功能回归，显式关闭压力测量', () => {
  const result = runNative()
  expect(result.status, result.stderr).toBe(0)
  expect(result.calls[0]).toMatchObject({
    tool: 'npm',
    args: ['run', 'build:native-canvas'],
  })
  const args = result.calls[1]?.args ?? []
  // 命令契约：quality-gate-push.md 的 Native Regression And Stress。
  expect(result.calls[1]?.stress).toBe('0')
  expect(args.some((arg) => arg.startsWith('-only-testing'))).toBe(false)
  expect(args.some((arg) => arg.startsWith('-skip-testing'))).toBe(false)
  expect(args.slice(-3)).toEqual(['-parallel-testing-enabled', 'NO', 'test'])
})

it('stress 显式开启原规模测量，保留性能报告校验', () => {
  const result = runNative('stress')
  expect(result.status, result.stderr).toBe(0)
  const args = result.calls[1]?.args ?? []
  expect(result.calls[1]?.stress).toBe('1')
  expect(args.filter((arg) => arg.startsWith('-only-testing:'))).toEqual([
    '-only-testing:PlotWeaveNativeTests/WebCanvasPerformanceTests',
    '-only-testing:PlotWeaveNativeTests/WebCanvasFirstDragLatencyTests/sameNodeFirstAndSecondDragRecordStartupEvidence()',
  ])
})

it.each([
  [23, 0, 1],
  [0, 65, 2],
])('构建状态 %i / 测试状态 %i 透传失败', (npmExit, xcodeExit, calls) => {
  const result = runNative(undefined, npmExit, xcodeExit)
  expect(result.status).toBe(npmExit || xcodeExit)
  expect(result.calls).toHaveLength(calls)
})

it('未知模式在启动构建前失败', () => {
  const result = runNative('invalid')
  expect(result.status).toBe(2)
  expect(result.calls).toEqual([])
})
