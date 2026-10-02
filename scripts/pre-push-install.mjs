/** 执行被推树的 npm ci：隔离 Sonar 环境变量，并有界终止安装进程组（issue #462）。 */
import { spawn } from 'node:child_process'

/** 向安装进程组发信号；已经结束的进程组无需再次清理。 */
function signalInstallation(child, signal) {
  if (!child.pid) return
  try {
    process.kill(-child.pid, signal)
  } catch (error) {
    if (error.code !== 'ESRCH') {
      console.error(`[PRE_PUSH_INSTALL_CLEANUP_FAILED] ${error.code}`)
    }
  }
}

/** 监督安装及其后代，超时或中断后先 TERM，1 秒后 KILL，再报告失败。 */
function runInstallation(timeoutSeconds) {
  const environment = { ...process.env }
  delete environment.SONAR_TOKEN
  delete environment.PLOTWEAVE_SONAR_TOKEN
  return new Promise((resolve) => {
    const child = spawn(process.env.PLOTWEAVE_NPM_BIN ?? 'npm', ['ci'], {
      env: environment,
      detached: true,
      stdio: ['ignore', 'inherit', 'inherit'],
    })
    let stopping = false
    let closed = false
    let forced = false
    let escalation
    const finish = (code) => {
      clearTimeout(deadline)
      clearTimeout(escalation)
      process.removeListener('SIGINT', interrupt)
      process.removeListener('SIGTERM', interrupt)
      resolve(code)
    }
    const stop = (diagnostic) => {
      if (stopping) return
      stopping = true
      console.error(diagnostic)
      signalInstallation(child, 'SIGTERM')
      escalation = setTimeout(() => {
        forced = true
        signalInstallation(child, 'SIGKILL')
        if (closed) finish(1)
      }, 1000)
    }
    const interrupt = () => stop('[PRE_PUSH_INSTALL_INTERRUPTED] 安装被中断')
    const deadline = setTimeout(() => {
      stop(`[PRE_PUSH_INSTALL_TIMEOUT] npm ci 超过 ${timeoutSeconds} 秒`)
    }, timeoutSeconds * 1000)
    process.on('SIGINT', interrupt)
    process.on('SIGTERM', interrupt)
    child.once('error', (error) => {
      console.error(`[PRE_PUSH_INSTALL_START_FAILED] ${error.code}`)
      finish(1)
    })
    child.once('close', (code) => {
      closed = true
      if (stopping && !forced) return
      if (code !== 0 && !stopping) {
        console.error(`[PRE_PUSH_INSTALL_FAILED] npm ci 退出码 ${code}`)
      }
      finish(stopping ? 1 : (code ?? 1))
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
