/** 独立监督安装进程组的期限；安装监督器被 SIGSTOP 后仍执行有界清理（issue #497）。 */

/** 发送进程或组信号，确认 ESRCH 后不再安排该目标的升级信号。 */
function signalTarget(pid, signal) {
  try {
    process.kill(pid, signal)
    return 'signaled'
  } catch (error) {
    if (error.code === 'ESRCH') return 'absent'
    console.error(`[PRE_PUSH_INSTALL_CLEANUP_FAILED] ${error.code}`)
    return 'failed'
  }
}

/** 以 IPC 释放期限；超时或监督器失联后直接清理安装组，失败状态不可撤销。 */
function runWatchdog(installationGroupPid, supervisorPid, timeoutSeconds) {
  let stopping = false
  let released = false
  let installationAbsent = false
  let canTerminateSupervisor = true
  let cleanupDeadline
  let escalation
  const installationDeadline = setTimeout(() => {
    terminate(`[PRE_PUSH_INSTALL_TIMEOUT] npm ci 超过 ${timeoutSeconds} 秒`)
  }, timeoutSeconds * 1000)

  /** 完成期限生命周期并关闭 IPC，让退出码随全部清理动作结算。 */
  function finish(code) {
    clearTimeout(installationDeadline)
    clearTimeout(cleanupDeadline)
    clearTimeout(escalation)
    process.exitCode = code
    if (process.connected) process.disconnect()
  }

  /** 最后终止仍连接的监督器；失联后不再向可能复用的监督器 PID 发信号。 */
  function finishTermination() {
    if (canTerminateSupervisor && process.connected) {
      signalTarget(supervisorPid, 'SIGKILL')
    }
    finish(1)
  }

  /** 独立执行 TERM → 一秒宽限 → KILL；开始清理后忽略正常释放请求。 */
  function terminate(diagnostic) {
    if (stopping || released) return
    stopping = true
    clearTimeout(installationDeadline)
    clearTimeout(cleanupDeadline)
    if (diagnostic) console.error(diagnostic)
    if (
      installationAbsent ||
      signalTarget(-installationGroupPid, 'SIGTERM') === 'absent'
    ) {
      finishTermination()
      return
    }
    escalation = setTimeout(() => {
      if (!installationAbsent) signalTarget(-installationGroupPid, 'SIGKILL')
      finishTermination()
    }, 1000)
  }

  process.on('message', (message) => {
    if (message === 'absent') {
      installationAbsent = true
      return
    }
    if (stopping || released) return
    if (message === 'release') {
      released = true
      finish(0)
    } else if (message === 'cleanup' && !cleanupDeadline) {
      clearTimeout(installationDeadline)
      cleanupDeadline = setTimeout(() => {
        terminate('[PRE_PUSH_INSTALL_TIMEOUT] 安装清理超过 2 秒')
      }, 2000)
    }
  })
  process.on('disconnect', () => {
    canTerminateSupervisor = false
    if (!released) terminate()
  })
  process.send('ready', (error) => {
    if (!error) return
    canTerminateSupervisor = false
    terminate()
  })
}

const argumentsValid =
  process.argv.slice(2).length === 3 &&
  process.argv.slice(2).every((value) => /^[1-9]\d*$/.test(value))
const [installationGroupPid, supervisorPid, timeoutSeconds] = process.argv
  .slice(2)
  .map(Number)
if (
  !argumentsValid ||
  !Number.isSafeInteger(installationGroupPid) ||
  !Number.isSafeInteger(supervisorPid) ||
  installationGroupPid <= 1 ||
  supervisorPid <= 1 ||
  timeoutSeconds > 2147483 ||
  !process.send
) {
  console.error('[PRE_PUSH_INSTALL_CLEANUP_FAILED] EINVAL')
  process.exitCode = 1
} else {
  runWatchdog(installationGroupPid, supervisorPid, timeoutSeconds)
}
