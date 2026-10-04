/** 独立期限的 IPC 状态回归：确认安装组消失后，不再信号可能复用的组号。 */
import { fork, spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { afterEach, expect, it } from 'vitest'

const watcherPath = resolve(
  import.meta.dirname,
  'pre-push-install-watchdog.mjs',
)
const temporaryDirectories: string[] = []
const fixtureProcesses: {
  child: ChildProcess
  completion: Promise<unknown>
}[] = []

/** 所有进程均由本测试创建，失败时也等待退出并回收进程。 */
function trackProcess(child: ChildProcess): ChildProcess {
  fixtureProcesses.push({ child, completion: once(child, 'exit') })
  return child
}

/** 创建能观察 TERM 的独立哨兵；真实 KILL 仍会终止它。 */
async function createSentinel(): Promise<ChildProcess> {
  const child = trackProcess(
    spawn(
      process.execPath,
      [
        '-e',
        String.raw`
process.on('SIGTERM', () => process.send('term'))
process.send('ready')
setInterval(() => {}, 1000)`,
      ],
      { detached: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] },
    ),
  )
  await once(child, 'message', { signal: AbortSignal.timeout(5000) })
  return child
}

/** 用真实已退出进程的旧组号，并把后续信号映射到另一独立组模拟组号复用。 */
async function createWatchdog(timeoutSeconds: number) {
  const root = mkdtempSync(resolve(tmpdir(), 'plotweave-watchdog-'))
  temporaryDirectories.push(root)
  const sentinel = await createSentinel()
  const supervisor = await createSentinel()
  const original = trackProcess(
    spawn(process.execPath, ['-e', 'process.exit(0)'], {
      detached: true,
      stdio: 'ignore',
    }),
  )
  await once(original, 'exit')
  if (!original.pid || !sentinel.pid || !supervisor.pid) {
    throw new Error('测试监督进程缺少 PID')
  }
  const preload = resolve(root, 'reuse-group.mjs')
  writeFileSync(
    preload,
    `const realKill = process.kill.bind(process)
process.kill = (pid, signal) => realKill(pid === -${original.pid} ? -${sentinel.pid} : pid, signal)`,
  )
  const watcher = trackProcess(
    fork(
      watcherPath,
      [String(original.pid), String(supervisor.pid), String(timeoutSeconds)],
      {
        detached: true,
        execArgv: ['--import', preload],
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      },
    ),
  )
  await once(watcher, 'message', { signal: AbortSignal.timeout(5000) })
  return { watcher, sentinel, supervisor }
}

/** IPC 发送错误必须令测试失败，避免把未送达的状态当成已交接。 */
function sendMessage(child: ChildProcess, message: string): Promise<void> {
  return new Promise((resolve, reject) => {
    child.send(message, (error) => (error ? reject(error) : resolve()))
  })
}

/** 只检查测试创建的进程是否仍存活；非 ESRCH 信号错误保持可见。 */
function processAlive(child: ChildProcess): boolean {
  if (!child.pid) return false
  try {
    process.kill(child.pid, 0)
    return true
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ESRCH') {
      return false
    }
    throw error
  }
}

/** 延迟真实 launcher 的 close，并把 watchdog 在 ESRCH 后的旧组信号映射到哨兵。 */
function writeAbsenceWiringProbe(root: string, sentinelPid: number): string {
  const preload = resolve(root, 'absence-wiring.mjs')
  const marker = JSON.stringify(resolve(root, 'group.absent'))
  writeFileSync(
    preload,
    `import childProcess from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
import { existsSync, writeFileSync } from 'node:fs'
const realKill = process.kill.bind(process)
if (process.argv[1]?.endsWith('/pre-push-install.mjs')) {
  const realSpawn = childProcess.spawn
  childProcess.spawn = (...args) => {
    const child = realSpawn(...args)
    if (!args[1]?.[0]?.endsWith('/pre-push-install-launcher.mjs')) return child
    const realEmit = child.emit.bind(child)
    child.emit = (event, ...values) => {
      if (event === 'close') {
        setTimeout(() => realEmit(event, ...values), 5000)
        return true
      }
      return realEmit(event, ...values)
    }
    child.once('exit', () => process.kill(process.pid, 'SIGHUP'))
    return child
  }
  process.kill = (pid, signal) => {
    try { return realKill(pid, signal) }
    catch (error) {
      if (pid < 0 && error.code === 'ESRCH') writeFileSync(${marker}, 'observed')
      throw error
    }
  }
  syncBuiltinESMExports()
} else if (process.argv[1]?.endsWith('/pre-push-install-watchdog.mjs')) {
  const installationGroup = -Number(process.argv[2])
  process.kill = (pid, signal) => realKill(
    pid === installationGroup && existsSync(${marker}) ? -${sentinelPid} : pid,
    signal,
  )
}`,
  )
  return preload
}

afterEach(async () => {
  for (const { child, completion } of fixtureProcesses.splice(0)) {
    child.kill('SIGKILL')
    await completion
  }
  for (const root of temporaryDirectories.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

it('监督器确认 ESRCH 后，清理兜底不再信号复用组号（issue #497）', async () => {
  const { watcher, sentinel, supervisor } = await createWatchdog(10)
  const completion = once(watcher, 'exit')
  await sendMessage(watcher, 'absent')
  await sendMessage(watcher, 'cleanup')
  const [code] = await completion
  expect(code).toBe(1)
  expect(processAlive(supervisor)).toBe(false)
  expect(processAlive(sentinel)).toBe(true)
})

it('期限已发 TERM 后收到 absent，仍失败且不再发 KILL（issue #497）', async () => {
  const { watcher, sentinel, supervisor } = await createWatchdog(1)
  const completion = once(watcher, 'exit')
  const [message] = await once(sentinel, 'message', {
    signal: AbortSignal.timeout(5000),
  })
  expect(message).toBe('term')
  await sendMessage(watcher, 'absent')
  const [code] = await completion
  expect(code).toBe(1)
  expect(processAlive(supervisor)).toBe(false)
  expect(processAlive(sentinel)).toBe(true)
})

it.each(['release', 'disconnect'] as const)(
  '确认 absent 后 $0 不再信号安装组（issue #497）',
  async (transition) => {
    const { watcher, sentinel, supervisor } = await createWatchdog(10)
    const completion = once(watcher, 'exit')
    await sendMessage(watcher, 'absent')
    if (transition === 'release') await sendMessage(watcher, 'release')
    else watcher.disconnect()
    const [code] = await completion
    expect(code).toBe(transition === 'release' ? 0 : 1)
    expect(processAlive(supervisor)).toBe(true)
    expect(processAlive(sentinel)).toBe(true)
  },
)

it('真实监督器的 ESRCH 结论传到独立期限，清理兜底保留哨兵（issue #497）', async () => {
  const root = mkdtempSync(resolve(tmpdir(), 'plotweave-watchdog-wiring-'))
  temporaryDirectories.push(root)
  const sentinel = await createSentinel()
  if (!sentinel.pid) throw new Error('测试哨兵缺少 PID')
  const preload = writeAbsenceWiringProbe(root, sentinel.pid)
  writeFileSync(resolve(root, 'ci'), 'process.exit(0)')
  const runner = trackProcess(
    spawn(
      process.execPath,
      [resolve(import.meta.dirname, 'pre-push-install.mjs')],
      {
        cwd: root,
        env: {
          ...process.env,
          NODE_OPTIONS: `--import=${preload}`,
          PLOTWEAVE_NPM_BIN: process.execPath,
          PLOTWEAVE_NPM_INSTALL_TIMEOUT: '10',
        },
        stdio: 'ignore',
      },
    ),
  )
  const [code, signal] = await once(runner, 'exit')
  expect(code).not.toBe(0)
  expect(signal).toBe('SIGKILL')
  expect(existsSync(resolve(root, 'group.absent'))).toBe(true)
  expect(processAlive(sentinel)).toBe(true)
})
