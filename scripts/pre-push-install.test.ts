/** 安装监督器的中断与启动失败回归：真实 Unix 子进程，不连接 registry 或 Sonar。 */
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { afterEach, expect, it } from 'vitest'

const runner = resolve(import.meta.dirname, 'pre-push-install.mjs')
const temporaryDirectories: string[] = []

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

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

it.each(['SIGINT', 'SIGTERM'] as const)(
  '执行器收到 %s 后阻止成功并终止忽略 TERM 的安装进程（issue #462）',
  { timeout: 15_000 },
  async (signal) => {
    const { root, env } = prepareInstallEnvironment()
    writeFileSync(
      resolve(root, 'ci'),
      String.raw`
require('node:fs').writeFileSync('install.pid', String(process.pid))
process.on('SIGTERM', () => {})
process.stdout.write('ready')
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
      child.kill(signal)
      const [code] = await completion
      expect(code).toBe(1)
      // Stable diagnostic contract: quality-gate-push.md, issue #462.
      expect(stderr).toContain('[PRE_PUSH_INSTALL_INTERRUPTED]')
      expect(() => process.kill(pid, 0)).toThrow()
    } finally {
      child.kill('SIGTERM')
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
    timeout: 5000,
  })
  expect(result.status).toBe(1)
  expect(result.error).toBeUndefined()
  // Stable diagnostic contract: quality-gate-push.md, issue #462.
  expect(result.stderr).toContain('[PRE_PUSH_INSTALL_START_FAILED] ENOENT')
  expect(result.stderr).not.toContain('[PRE_PUSH_INSTALL_TIMEOUT]')
})
