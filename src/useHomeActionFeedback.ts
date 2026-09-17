import { useCallback, useRef, useState } from 'react'
import type { HomeActionFailure } from './home/ActionErrorBanner'

/** 首页项目变更失败反馈（issue #132，自 App.tsx 拆出守文件行数上限）：
 * 创建/重命名/复制/删除四动作共用。尝试开始即清旧错（新尝试视为旧错误
 * 过时），结果按尝试序提交——旧尝试的迟到失败不得覆盖新尝试的已清
 * 状态；失败态携带同参重发的重试闭包（可缺省：非幂等操作部分提交后
 * 不得提供盲重试，PR #199 评审）。 */
export function useHomeActionFeedback() {
  const [failure, setFailure] = useState<{
    readonly error: HomeActionFailure
    readonly retry?: () => void
  } | null>(null)
  const seqRef = useRef(0)
  /** 尝试开始：作废旧错误，返回本次尝试序号。 */
  const begin = useCallback(() => {
    const seq = ++seqRef.current
    setFailure(null)
    return seq
  }, [])
  /** 尝试失败（序号仍为最新才提交）：登记动作/目标/诊断与可选重试闭包。 */
  const fail = useCallback(
    (seq: number, error: HomeActionFailure, retry?: () => void) => {
      if (seq === seqRef.current) setFailure({ error, retry })
    },
    [],
  )
  /** 尝试成功（序号仍为最新才提交）：清除失败态，不虚报也不残留。 */
  const succeed = useCallback((seq: number) => {
    if (seq === seqRef.current) setFailure(null)
  }, [])
  const retry = useCallback(() => {
    failure?.retry?.()
  }, [failure])
  return { failure, begin, fail, succeed, retry }
}
