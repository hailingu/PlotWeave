/** Process-lifetime subscriptions; consumers own explicit unsubscribe lifetimes. */
import type { ProjectContent } from '../model/content'

/** 回吐重排失败监听器：回吐的写入是墓碑期吸收的迟到排队，原始调用方
 * 早已拿到成功应答、无从上浮失败——订阅方（如 AI 会话存储）由此把保留
 * 快照交给上层恢复通道。 */
export type ProjectWriteReplayFailureListener = (
  id: string,
  err: unknown,
) => void
const replayFailureListeners = new Set<ProjectWriteReplayFailureListener>()

/** 订阅删除失败后回吐重排的附属写入失败；返回退订函数。 */
export function onProjectWriteReplayFailure(
  listener: ProjectWriteReplayFailureListener,
): () => void {
  replayFailureListeners.add(listener)
  return () => replayFailureListeners.delete(listener)
}

/** 项目文档保存落定监听器：入参为落盘成功的项目 id。 */
export type ProjectSavedListener = (id: string) => void
const savedListeners = new Set<ProjectSavedListener>()

/** 订阅项目文档保存落定（issue #101）：链上每一次保存成功都通知——编辑器
 * 卸载冲刷/在途保存可以晚于返回首页的列表读取，保存失败登记后的后台重试
 * 成功也发生在编辑器卸载之后，首页摘要只能靠这条通知恢复到与磁盘一致。
 * 保存失败不通知（磁盘保持旧内容，首页不得虚报新摘要）。返回退订函数。 */
export function onProjectSaved(listener: ProjectSavedListener): () => void {
  savedListeners.add(listener)
  return () => savedListeners.delete(listener)
}

/** 保存落定通知的补发口（issue #101）：仅供不经保存链的内存回退路径在
 * 门面保存成功后调用；链上路径的通知由 enqueueSave 成功段自带。 */
export function notifyProjectSaved(id: string): void {
  savedListeners.forEach((listener) => listener(id))
}

/** 登记文档重存成功监听器：入参为已落盘的登记文档对象（与登记为同一
 * 引用）。 */
export type RetryPersistedListener = (doc: ProjectContent) => void
const retryPersistedListeners = new Set<RetryPersistedListener>()

/** 订阅登记文档经链上重存成功：画布冲刷闸据此清除对应脏态，退出屏障的
 * 定点检查不再对已落盘文档发起冗余重存（PR #174 评审）。返回退订函数。 */
export function onRetryPersisted(listener: RetryPersistedListener): () => void {
  retryPersistedListeners.add(listener)
  return () => retryPersistedListeners.delete(listener)
}

/** 登记文档重存成功的通知口（enqueueSave 落定登记文档时触发；独立导出
 * 供测试注入）。 */
export function notifyRetryPersisted(doc: ProjectContent): void {
  retryPersistedListeners.forEach((listener) => listener(doc))
}

/** Forward replay failures after the absorbed caller has already received success. */
export function notifyProjectWriteReplayFailure(
  id: string,
  err: unknown,
): void {
  replayFailureListeners.forEach((listener) => listener(id, err))
}
