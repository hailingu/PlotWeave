/**
 * 在途回合的按项目归属注册表（issue #63）：进出设置页或返回首页会整体
 * 卸载编辑器，模型回合的迟到完成落在已卸载组件上被丢弃——用户消息已
 * 落盘而回复缺失，形成半截对话。本模块把在途回合以项目 id 登记于
 * 进程内注册表：发起方（useAiTurn.send）登记，重挂载/重开同一项目的
 * AiThread 独占认领（等待中恢复忙碌态，落定后重定条目 id 入列并经既有
 * 保存通道落盘），认领方再卸载时归还待下次认领。
 *
 * 归属不跨进程：重启不恢复在途回合（数据模型 §12.2）；按项目隔离，
 * 迟到响应不写入其他项目。busy 门闸保证每项目至多一轮在途，注册表
 * 槽位为单盒子。
 */
import type { ThreadEntry } from './session'

/** 一轮模型回合的落定结果：成功条目或失败原因，二选一。 */
export interface TurnResult {
  readonly entries: ThreadEntry[] | null
  readonly error: string | null
}

/** 在途回合容器：promise 落定后持有结果；由注册表跨卸载转交给认领方。 */
export interface TurnBox {
  readonly promise: Promise<TurnResult>
}

const boxes = new Map<string, TurnBox>()

/** 发起方登记项目当前在途回合。 */
export function registerTurn(projectId: string, box: TurnBox): void {
  boxes.set(projectId, box)
}

/** 发起方仍挂载并消费结果时撤销登记：迟到的旧回合不得清掉后来者。 */
export function unregisterTurn(projectId: string, box: TurnBox): void {
  if (boxes.get(projectId) === box) boxes.delete(projectId)
}

/** 认领方取走项目的待认领回合（独占转交，移出注册表）；无在途返回 null。 */
export function takeTurn(projectId: string): TurnBox | null {
  const box = boxes.get(projectId) ?? null
  if (box) boxes.delete(projectId)
  return box
}

/** 认领方在落定前卸载时归还注册表；槽位已被新回合占用时不归还。 */
export function returnTurn(projectId: string, box: TurnBox): void {
  if (!boxes.has(projectId)) boxes.set(projectId, box)
}
