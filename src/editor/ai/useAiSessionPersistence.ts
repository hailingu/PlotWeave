/**
 * 面板会话的「编辑即保存」域（issue #47，自 AiThread 拆出；映射在
 * session.ts）：落盘形态映射 persistedEntries 与落盘边界容量 diskSessionOf
 * 由会话格式模块拥有；本 hook 在条目变更时把全量落盘形态经 onSaveSession
 * 上交（快照通道持全量，容量裁剪在 aiSessionStore 写入时施加，issue #64），
 * 失败上浮为面板可见错误（不清空内存历史）。
 */
import { useEffect, useRef, useState } from 'react'
import type { AiSession, ThreadEntry } from './session'
import { persistedEntries } from './session'

/** 面板会话的「编辑即保存」状态族：条目变更即落盘；保存失败上浮为可见
 * 错误且不清空内存历史。带错误挂载时按 initialSessionRetryable 决定是否
 * 首帧重试——读取失败的空回退会话不可重试（落盘会覆盖可能可恢复的原
 * 文件），须等用户实际变更对话后才随变更保存。项目级错误（App 的
 * aiSessionError）双向同步：非空到达即展示，转空也随之清除——退出重试
 * 保存成功不经面板保存通道，只有项目级清除能把横幅撤下；面板每次保存
 * 都经 App 通道更新项目级状态，双向同步最终一致。 */
export function useAiSessionPersistence(
  thread: ThreadEntry[],
  initialSessionError: string | null | undefined,
  onSaveSession: ((session: AiSession) => Promise<void>) | undefined,
  initialSessionRetryable: boolean | undefined,
): string | null {
  const [saveError, setSaveError] = useState<string | null>(initialSessionError ?? null)
  const hasMounted = useRef(false)
  const retryOnMount = useRef(initialSessionError != null && initialSessionRetryable !== false)
  const saveSessionRef = useRef(onSaveSession)
  useEffect(() => {
    saveSessionRef.current = onSaveSession
  }, [onSaveSession])
  useEffect(() => {
    setSaveError(initialSessionError ?? null)
  }, [initialSessionError])
  useEffect(() => {
    const first = !hasMounted.current
    hasMounted.current = true
    if (first && !retryOnMount.current) return
    const save = saveSessionRef.current
    if (!save) return
    void save({ schemaVersion: 1, entries: persistedEntries(thread) })
      .then(() => setSaveError(null))
      .catch((err: unknown) => setSaveError(String(err)))
  }, [thread])
  return saveError
}
