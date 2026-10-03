/** 执行被推树的 npm ci：隔离 Sonar 环境变量，并独立监督安装期限（#462/#497）。 */
import { fork, spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

/** 区分信号已发送、组已不存在和发送失败，避免向已释放的组号继续发信号。 */
function signalInstallation(child, signal) {
  if (!child?.pid) return 'absent'
  try {
    process.kill(-child.pid, signal)
    return 'signaled'
  } catch (error) {
    if (error.code === 'ESRCH') return 'absent'
    console.error(`[PRE_PUSH_INSTALL_CLEANUP_FAILED] ${error.code}`)
    return 'failed'
  }
}

/** 建立独立期限并以握手放行安装；完成时等待撤销，异常退出始终失败关闭。 */
function startWatchdog(child, timeoutSeconds, environment, unavailable) {
  const watcher = fork(
    new URL('./pre-push-install-watchdog.mjs', import.meta.url),
    [String(child.pid), String(process.pid), String(timeoutSeconds)],
    {
      detached: true,
      env: environment,
      execArgv: [],
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    },
  )
  let cleaning = false
  let released = false
  const completion = new Promise((resolve) => {
    watcher.once('exit', (code) => {
      if (!released)
        unavailable('[PRE_PUSH_INSTALL_WATCHDOG_FAILED] 期限进程提前退出')
      resolve(code === 0)
    })
    watcher.once('error', (error) => {
      unavailable(`[PRE_PUSH_INSTALL_WATCHDOG_FAILED] ${error.code}`)
      resolve(false)
    })
  })
  const send = (message) => {
    if (watcher.connected)
      watcher.send(message, (error) => {
        if (error)
          unavailable(`[PRE_PUSH_INSTALL_WATCHDOG_FAILED] ${error.code}`)
      })
  }
  watcher.once('message', (message) => {
    if (message !== 'ready' || released || cleaning) return
    if (child.connected)
      child.send('start', (error) => {
        if (error) unavailable(`[PRE_PUSH_INSTALL_START_FAILED] ${error.code}`)
      })
  })
  return {
    /** npm 结束或中断后以清理期限接替安装期限，禁止再启动 launcher。 */
    cleanup() {
      cleaning = true
      send('cleanup')
    },
    /** 共享 ESRCH 结论；外部清理不得再次操作已释放的安装组号。 */
    absent() {
      cleaning = true
      send('absent')
    },
    /** 等待外部期限撤销后结算安装，避免向已释放的组号继续发信号。 */
    release() {
      released = true
      send('release')
      return completion
    },
  }
}

/** 清理全部监听器并等待 watchdog 撤销；撤销失败也不得报告安装成功。 */
function finishInstallation(state, code) {
  if (state.finished) return
  state.finished = true
  clearTimeout(state.deadline)
  clearTimeout(state.escalation)
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.removeListener(signal, state.interrupt)
  }
  if (state.watchdog) {
    state.watchdog
      .release()
      .then((accepted) => state.resolve(accepted ? code : 1))
  } else state.resolve(code)
}

/** 收敛每个停止入口；失败覆盖成功，TERM 后统一以一秒宽限升级 KILL。 */
function stopInstallation(state, diagnostic, code = 1) {
  if (diagnostic) {
    state.resultCode = 1
    console.error(diagnostic)
  }
  if (state.stopping) return
  state.stopping = true
  state.resultCode = code
  clearTimeout(state.deadline)
  state.watchdog?.cleanup()
  const termination = signalInstallation(state.child, 'SIGTERM')
  if (termination === 'absent') {
    state.watchdog?.absent()
    state.cleanupSettled = true
    return
  }
  if (termination === 'failed') state.resultCode = 1
  state.escalation = setTimeout(() => {
    state.cleanupSettled = true
    const result = signalInstallation(state.child, 'SIGKILL')
    if (result === 'absent') state.watchdog?.absent()
    if (result === 'failed') state.resultCode = 1
    if (state.closed) finishInstallation(state, state.resultCode)
  }, 1000)
}

/** npm 结果只能在组清理完成后返回，已收到的中断或超时始终保持失败。 */
function closeInstallation(state, code) {
  if (state.closed) return
  state.closed = true
  if (code !== 0 && !state.stopping) {
    console.error(`[PRE_PUSH_INSTALL_FAILED] npm ci 退出码 ${code}`)
  }
  stopInstallation(state, undefined, code ?? 1)
  if (state.cleanupSettled) finishInstallation(state, state.resultCode)
}

/** 启动前注册全部中断入口，拥有安装与后代清理的单一完成状态。 */
function installationControl(timeoutSeconds, resolve) {
  const state = {
    resolve,
    stopping: false,
    closed: false,
    cleanupSettled: false,
    finished: false,
    resultCode: 1,
  }
  state.stop = (diagnostic, code) => stopInstallation(state, diagnostic, code)
  state.interrupt = () =>
    state.stop('[PRE_PUSH_INSTALL_INTERRUPTED] 安装被中断')
  state.deadline = setTimeout(() => {
    state.stop(`[PRE_PUSH_INSTALL_TIMEOUT] npm ci 超过 ${timeoutSeconds} 秒`)
  }, timeoutSeconds * 1000)
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(signal, state.interrupt)
  }
  return state
}

/** 先创建安装组和独立 watchdog，握手之前 launcher 不执行被推树的代码。 */
function runInstallation(timeoutSeconds) {
  const environment = { ...process.env }
  delete environment.SONAR_TOKEN
  delete environment.PLOTWEAVE_SONAR_TOKEN
  return new Promise((resolve) => {
    const control = installationControl(timeoutSeconds, resolve)
    const child = spawn(
      process.execPath,
      [
        fileURLToPath(
          new URL('./pre-push-install-launcher.mjs', import.meta.url),
        ),
      ],
      {
        env: environment,
        detached: true,
        stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
      },
    )
    const watchdog = startWatchdog(
      child,
      timeoutSeconds,
      environment,
      control.stop,
    )
    control.child = child
    control.watchdog = watchdog
    child.once('error', (error) => {
      console.error(`[PRE_PUSH_INSTALL_START_FAILED] ${error.code}`)
      control.closed = true
      finishInstallation(control, 1)
    })
    child.once('close', (code) => closeInstallation(control, code))
  })
}

const timeoutValue = process.env.PLOTWEAVE_NPM_INSTALL_TIMEOUT ?? '300'
const timeoutSeconds = Number(timeoutValue)
if (!/^[1-9]\d*$/.test(timeoutValue) || timeoutSeconds > 2147483) {
  console.error(
    '[PRE_PUSH_INSTALL_TIMEOUT_INVALID] 安装期限必须为 1..2147483 的整数秒',
  )
  process.exitCode = 1
} else if (process.platform === 'win32') {
  console.error(
    '[PRE_PUSH_INSTALL_PLATFORM_UNSUPPORTED] 安装进程组清理需要 Unix',
  )
  process.exitCode = 1
} else {
  process.exitCode = await runInstallation(timeoutSeconds)
}
