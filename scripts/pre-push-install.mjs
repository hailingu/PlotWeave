/** 执行被推树的 npm ci：隔离 Sonar 环境变量，并有界终止安装进程组（issue #462）。 */
import { spawn } from 'node:child_process'

/** 区分信号已发送、组已不存在和发送失败，避免向已释放的组号继续发信号。 */
function signalInstallation(child, signal) {
  if (!child.pid) return 'absent'
  try {
    process.kill(-child.pid, signal)
    return 'signaled'
  } catch (error) {
    if (error.code === 'ESRCH') return 'absent'
    console.error(`[PRE_PUSH_INSTALL_CLEANUP_FAILED] ${error.code}`)
    return 'failed'
  }
}

/** 监督安装及其后代；所有完成路径先清理进程组，中断始终报告失败。 */
function runInstallation(timeoutSeconds) {
  const environment = { ...process.env }
  delete environment.SONAR_TOKEN
  delete environment.PLOTWEAVE_SONAR_TOKEN
  return new Promise((resolve) => {
    let child
    let stopping = false
    let closed = false
    let cleanupSettled = false
    let resultCode = 1
    let escalation
    const finish = (code) => {
      clearTimeout(deadline)
      clearTimeout(escalation)
      process.removeListener('SIGINT', interrupt)
      process.removeListener('SIGTERM', interrupt)
      process.removeListener('SIGHUP', interrupt)
      resolve(code)
    }
    const stop = (diagnostic, code = 1) => {
      if (diagnostic) {
        resultCode = 1
        console.error(diagnostic)
      }
      if (stopping) return
      stopping = true
      resultCode = code
      clearTimeout(deadline)
      const termination = signalInstallation(child, 'SIGTERM')
      if (termination === 'absent') {
        cleanupSettled = true
        return
      }
      if (termination === 'failed') resultCode = 1
      escalation = setTimeout(() => {
        cleanupSettled = true
        if (signalInstallation(child, 'SIGKILL') === 'failed') resultCode = 1
        if (closed) finish(resultCode)
      }, 1000)
    }
    const interrupt = () => stop('[PRE_PUSH_INSTALL_INTERRUPTED] 安装被中断')
    const deadline = setTimeout(() => {
      stop(`[PRE_PUSH_INSTALL_TIMEOUT] npm ci 超过 ${timeoutSeconds} 秒`)
    }, timeoutSeconds * 1000)
    process.on('SIGINT', interrupt)
    process.on('SIGTERM', interrupt)
    process.on('SIGHUP', interrupt)
    child = spawn(process.env.PLOTWEAVE_NPM_BIN ?? 'npm', ['ci'], {
      env: environment,
      detached: true,
      stdio: ['ignore', 'inherit', 'inherit'],
    })
    child.once('error', (error) => {
      console.error(`[PRE_PUSH_INSTALL_START_FAILED] ${error.code}`)
      closed = true
      finish(1)
    })
    child.once('close', (code) => {
      if (closed) return
      closed = true
      if (code !== 0 && !stopping) {
        console.error(`[PRE_PUSH_INSTALL_FAILED] npm ci 退出码 ${code}`)
      }
      stop(undefined, code ?? 1)
      if (cleanupSettled) finish(resultCode)
    })
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
