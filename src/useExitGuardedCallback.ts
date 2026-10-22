/** 文档 owner 的最终写入口守卫，保持回调身份稳定且在修改 ref／状态前检查。 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { registerWebStateCommit } from './webExitFence'

/** draining 仍可交付既有工作；sealed 拒绝新状态，不运行 updater 或产生脏稿。 */
export function useExitGuardedCallback<Args extends unknown[]>(
  write: (...args: Args) => void,
): (...args: Args) => void {
  const pending = useRef(new Map<number, () => void>())
  const sequence = useRef(0)
  const [committed, setCommitted] = useState(0)
  useEffect(() => {
    for (const [revision, finish] of pending.current) {
      if (revision > committed) continue
      pending.current.delete(revision)
      finish()
    }
  }, [committed])
  useEffect(() => {
    const commits = pending.current
    return () => {
      commits.forEach((finish) => finish())
      commits.clear()
    }
  }, [])
  return useCallback(
    (...args: Args) => {
      const finish = registerWebStateCommit()
      const revision = ++sequence.current
      pending.current.set(revision, finish)
      try {
        write(...args)
        setCommitted(revision)
      } catch (error) {
        pending.current.delete(revision)
        finish()
        throw error
      }
    },
    [write],
  )
}
