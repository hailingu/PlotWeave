/** 安装监督器的中断与启动失败回归：真实 Unix 子进程，不连接 registry 或 Sonar。 */
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { afterEach, expect, it } from 'vitest'

const runner = resolve(import.meta.dirname, 'pre-push-install.mjs')
const temporaryDirectories: string[] = []

/** 创建 npm 已结束而同组后代仍活着的真实进程夹具。 */
function writeSurvivingDescendant(root: string, exitCode: number): void {
  writeFileSync(
    resolve(root, 'ci'),
    String.raw`
require('node:fs').writeFileSync('install.pid', String(process.pid))
const descendant = require('node:child_process').spawn(process.execPath, ['-e', [
  "process.on('SIGTERM', () => require('node:fs').writeFileSync('cleanup.started', 'ready'))",
  "require('node:fs').writeFileSync('descendant.pid', String(process.pid))",
  "process.send('ready')",
  "process.disconnect()",
  "setTimeout(() => process.exit(0), 10000)",
].join('\n')], { stdio: ['ignore', 'inherit', 'ignore', 'ipc'] })
descendant.once('message', () => process.exit(${exitCode}))
descendant.unref()`,
  )
}

/** 失败的回归也只清理自己创建的安装组，防止后台夹具泄漏。 */
function killInstallFixture(root: string): void {
  const pidPath = resolve(root, 'install.pid')
  if (existsSync(pidPath)) {
    signalFixtureProcess(-Number(readFileSync(pidPath, 'utf8')), 'SIGKILL')
  }
}

/** 创建当前执行器的独立安装目录，避免继承外层推送期限与 npm 替身。 */
function prepareInstallEnvironment(): {
  root: string
  env: NodeJS.ProcessEnv
} {
  const root = mkdtempSync(resolve(tmpdir(), 'plotweave-install-'))
  temporaryDirectories.push(root)
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PLOTWEAVE_NPM_BIN: process.execPath,
    PLOTWEAVE_NPM_INSTALL_TIMEOUT: '10',
  }
  delete env.SONAR_TOKEN
  delete env.PLOTWEAVE_SONAR_TOKEN
  return { root, env }
}

/** 只操作测试创建的进程或进程组；已退出返回 false，其他信号错误仍抛出。 */
function signalFixtureProcess(
  pid: number,
  signal: NodeJS.Signals | 0,
): boolean {
  try {
    process.kill(pid, signal)
    return true
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ESRCH') {
      return false
    }
    throw error
  }
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

it.each(['SIGINT', 'SIGTERM', 'SIGHUP'] as const)(
  '执行器收到 %s 后阻止成功并终止忽略 TERM 的安装进程组（issue #462）',
  { timeout: 15_000 },
  async (signal) => {
    const { root, env } = prepareInstallEnvironment()
    writeFileSync(
      resolve(root, 'ci'),
      String.raw`
require('node:fs').writeFileSync('install.pid', String(process.pid))
process.on('SIGTERM', () => {})
const descendant = require('node:child_process').spawn(process.execPath, ['-e', [
  "process.on('SIGTERM', () => {})",
  "require('node:fs').writeFileSync('descendant.pid', String(process.pid))",
  "process.send('ready')",
  "setTimeout(() => process.exit(0), 10000)",
].join('\n')], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] })
descendant.once('message', () => process.stdout.write('ready'))
setTimeout(() => process.exit(0), 5000)`,
    )
    const child = spawn(process.execPath, [runner], { cwd: root, env })
    let stderr = ''
    child.stderr.on('data', (data: Buffer) => {
      stderr += data.toString()
    })
    const completion = once(child, 'close')
    try {
      await once(child.stdout, 'data', { signal: AbortSignal.timeout(5000) })
      const pid = Number(readFileSync(resolve(root, 'install.pid'), 'utf8'))
      const descendantPid = Number(
        readFileSync(resolve(root, 'descendant.pid'), 'utf8'),
      )
      child.kill(signal)
      const [code] = await completion
      expect(code).toBe(1)
      // Stable diagnostic contract: quality-gate-push.md, issue #462.
      expect(stderr).toContain('[PRE_PUSH_INSTALL_INTERRUPTED]')
      expect(() => process.kill(pid, 0)).toThrow()
      await expect
        .poll(() => signalFixtureProcess(descendantPid, 0))
        .toBe(false)
    } finally {
      child.kill('SIGTERM')
      const pidPath = resolve(root, 'install.pid')
      if (existsSync(pidPath)) {
        signalFixtureProcess(-Number(readFileSync(pidPath, 'utf8')), 'SIGKILL')
      }
      await completion
    }
  },
)

it('npm 无法启动时立即失败且不伪装为安装超时（issue #462）', () => {
  const { root, env } = prepareInstallEnvironment()
  env.PLOTWEAVE_NPM_BIN = resolve(root, 'missing-npm')
  const result = spawnSync(process.execPath, [runner], {
    cwd: root,
    env,
    encoding: 'utf8',
    timeout: 1000,
  })
  expect(result.status).toBe(1)
  expect(result.error).toBeUndefined()
  // Stable diagnostic contract: quality-gate-push.md, issue #462.
  expect(result.stderr).toContain('[PRE_PUSH_INSTALL_START_FAILED] ENOENT')
  expect(result.stderr).not.toContain('[PRE_PUSH_INSTALL_TIMEOUT]')
})

it.each([0, 7])(
  'npm 退出码 %s 必须在同组后台后代结束后才返回（评审 4162621737）',
  { timeout: 15_000 },
  async (exitCode) => {
    const { root, env } = prepareInstallEnvironment()
    writeSurvivingDescendant(root, exitCode)
    const child = spawn(process.execPath, [runner], {
      cwd: root,
      env,
      stdio: 'ignore',
    })
    try {
      const [code] = await once(child, 'close')
      expect(code).toBe(exitCode)
      const pid = Number(readFileSync(resolve(root, 'descendant.pid'), 'utf8'))
      await expect.poll(() => signalFixtureProcess(pid, 0)).toBe(false)
    } finally {
      killInstallFixture(root)
    }
  },
)

it.each(['SIGINT', 'SIGTERM', 'SIGHUP'] as const)(
  'spawn 尚未返回时收到 %s 仍清理安装组并返回失败（评审 4162621740）',
  async (signal) => {
    const { root, env } = prepareInstallEnvironment()
    writeFileSync(resolve(root, 'ci'), 'setTimeout(() => {}, 10000)')
    const preload = resolve(root, 'signal-during-spawn.mjs')
    writeFileSync(
      preload,
      `import childProcess from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
import { writeFileSync } from 'node:fs'
const realSpawn = childProcess.spawn
childProcess.spawn = (...args) => {
  const child = realSpawn(...args)
  writeFileSync('install.pid', String(child.pid))
  process.kill(process.pid, '${signal}')
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200)
  return child
}
syncBuiltinESMExports()`,
    )
    const child = spawn(process.execPath, ['--import', preload, runner], {
      cwd: root,
      env,
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    let stderr = ''
    child.stderr.on('data', (data: Buffer) => {
      stderr += data.toString()
    })
    try {
      const [code] = await once(child, 'exit')
      expect(code).toBe(1)
      // Stable diagnostic contract: quality-gate-push.md, issue #462.
      expect(stderr).toContain('[PRE_PUSH_INSTALL_INTERRUPTED]')
      const pid = Number(readFileSync(resolve(root, 'install.pid'), 'utf8'))
      expect(signalFixtureProcess(pid, 0)).toBe(false)
    } finally {
      killInstallFixture(root)
    }
  },
)

it('正常完成的后代清理期间收到中断仍返回失败（评审 4162621737）', async () => {
  const { root, env } = prepareInstallEnvironment()
  writeSurvivingDescendant(root, 0)
  const child = spawn(process.execPath, [runner], {
    cwd: root,
    env,
    stdio: 'ignore',
  })
  const completion = once(child, 'close')
  try {
    await expect
      .poll(() => existsSync(resolve(root, 'cleanup.started')))
      .toBe(true)
    child.kill('SIGHUP')
    const [code] = await completion
    expect(code).toBe(1)
    const pid = Number(readFileSync(resolve(root, 'descendant.pid'), 'utf8'))
    await expect.poll(() => signalFixtureProcess(pid, 0)).toBe(false)
  } finally {
    killInstallFixture(root)
    await completion
  }
})
