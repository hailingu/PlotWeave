import { useEffect, useState } from 'react'

/** Runtime-only lifecycle owned by useAiTurn; waiting time follows a claimed turn across mounts. */
export type AiTurnStatus =
  | { phase: 'idle' | 'completed' | 'cancelled' }
  | { phase: 'waiting'; startedAt: number }
  | { phase: 'failed'; error: string }

/** Credential-free, readable feedback shared by Web and native presentations. */
export interface AiTurnFeedback {
  phase: AiTurnStatus['phase'] | 'long-wait'
  title: string
  detail: string
  busy: boolean
}

/** Elapsed time changes the waiting explanation only, never declares a timeout or service activity. */
export function useAiTurnFeedback(status: AiTurnStatus): AiTurnFeedback | null {
  const [longWaitFor, setLongWaitFor] = useState<number | null>(null)
  const startedAt = status.phase === 'waiting' ? status.startedAt : null
  useEffect(() => {
    if (startedAt === null) return
    const timer = setTimeout(
      () => setLongWaitFor(startedAt),
      Math.max(0, startedAt + 30_000 - Date.now()),
    )
    return () => clearTimeout(timer)
  }, [startedAt])
  switch (status.phase) {
    case 'idle':
      return null
    case 'waiting':
      return {
        phase: longWaitFor === startedAt ? 'long-wait' : 'waiting',
        title:
          longWaitFor === startedAt ? '仍在等待 AI 回复…' : '正在等待 AI 回复…',
        detail:
          '回复返回后会显示在会话中；可取消本轮处理。等待时长不能确定服务是否异常。',
        busy: true,
      }
    case 'completed':
      return {
        phase: 'completed',
        title: '本轮回答已结束',
        detail: '如有改动预览，请确认后执行；回答结束不代表改动已执行。',
        busy: false,
      }
    case 'cancelled':
      return {
        phase: 'cancelled',
        title: '已停止本轮处理',
        detail: '在途服务请求可能仍会完成，其结果将被忽略。可重新发送。',
        busy: false,
      }
    case 'failed':
      return {
        phase: 'failed',
        title: '请求失败',
        detail: '请根据错误检查连接或模型设置后重新发送。',
        busy: false,
      }
  }
}
