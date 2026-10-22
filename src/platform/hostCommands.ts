/**
 * 宿主命令兼容入口（P2 宿主接口收敛，矩阵 M16）：沿用 typed IPC 的唯一
 * 传输、命令联合与宿主失败诊断。旧宿主消费方保留导出名，所有原始
 * Tauri invoke 绑定与测试传输的生命周期由 src/ipc/invoke.ts 统一持有。
 */
export {
  ipcInvoke as hostInvoke,
  HOST_COMMAND_UNAVAILABLE,
  HostCommandUnavailableError,
  setHostCommandTransportForTests,
  type HostCommandTransport,
} from '../ipc/invoke'
