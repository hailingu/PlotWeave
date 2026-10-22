/** 独立安装组入口：外部期限就绪后才启动 npm，并让所有后代继承本组（#497）。 */
import { spawn } from 'node:child_process'

let started = false
process.once('disconnect', () => {
  if (!started) process.exitCode = 1
})
process.once('message', (message) => {
  if (message !== 'start') {
    console.error('[PRE_PUSH_INSTALL_START_FAILED] 无效的安装启动握手')
    process.disconnect()
    process.exitCode = 1
    return
  }
  started = true
  process.disconnect()
  const child = spawn(process.env.PLOTWEAVE_NPM_BIN ?? 'npm', ['ci'], {
    stdio: ['ignore', 'inherit', 'inherit'],
  })
  let failed = false
  child.once('error', (error) => {
    failed = true
    console.error(`[PRE_PUSH_INSTALL_START_FAILED] ${error.code}`)
    process.exitCode = 1
  })
  child.once('close', (code) => {
    process.exitCode = failed ? 1 : (code ?? 1)
  })
})
