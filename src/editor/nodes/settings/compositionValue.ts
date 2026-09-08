/**
 * 组合输入（IME）安全受控值（issue #42）：中文拼音等组合输入期间，React 的
 * 合成 onChange 会随每个原生 input 事件触发（React 18 的 ChangeEventPlugin
 * 不按 isComposing 过滤，见 react-dom ChangeEventPlugin 的
 * getTargetInstForInputOrChangeEvent）。节点设置面板是「编辑即命令」：每次
 * onChange 立即 patch 节点 data，而节点 data 经 React Flow 内部仓库在
 * useEffect 中同步（StoreUpdater），受控值因此比 DOM 滞后一帧——组合进行中
 * React 会把旧值回写进输入框。WKWebView（macOS Tauri 的 webview）里，
 * 组合期间的程序化赋值会中断组合并把标记文本上屏，拼音于是逐段残留
 * （qqiqinqing）。本 hook 在组合期间只更新本地缓冲、不提交，compositionend
 * 才提交最终文本；非组合态仍逐键提交，编辑即命令语义不变。
 */
import { useEffect, useRef, useState, type ChangeEvent, type CompositionEvent } from 'react'

/** 可直接展开到 input / textarea 上的组合安全受控值。 */
export interface CompositionSafeValue {
  /** 展示值：组合期间为本地缓冲，其余时刻跟随外部值。 */
  readonly value: string
  readonly onChange: (event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => void
  readonly onCompositionStart: () => void
  readonly onCompositionEnd: (
    event: CompositionEvent<HTMLInputElement | HTMLTextAreaElement>,
  ) => void
}

/** 原生事件是否已标记组合中：少数浏览器先派发 input 再派发 compositionstart。 */
function isNativeComposing(event: { readonly nativeEvent: Event }): boolean {
  return (event.nativeEvent as Partial<InputEvent>).isComposing === true
}

/**
 * 把受控值包装成组合输入安全的字段属性：`commit` 只在非组合态与
 * compositionend 被调用；外部值（撤销/重做、AI 补丁）在非组合态回灌缓冲，
 * 组合中不回灌以免覆盖在途文本。
 */
export function useCompositionSafeValue(
  value: string,
  commit: (next: string) => void,
): CompositionSafeValue {
  const composing = useRef(false)
  /** 最近一次已提交值：上屏后的尾随 input 事件不重复产生补丁与撤销步。 */
  const lastEmitted = useRef(value)
  const [draft, setDraft] = useState(value)

  useEffect(() => {
    if (composing.current) return
    lastEmitted.current = value
    setDraft(value)
  }, [value])

  const emit = (next: string) => {
    if (next === lastEmitted.current) return
    lastEmitted.current = next
    commit(next)
  }

  return {
    value: draft,
    onChange: (event) => {
      const next = event.currentTarget.value
      setDraft(next)
      if (!composing.current && !isNativeComposing(event)) emit(next)
    },
    onCompositionStart: () => {
      composing.current = true
    },
    onCompositionEnd: (event) => {
      composing.current = false
      const next = event.currentTarget.value
      setDraft(next)
      emit(next)
    },
  }
}
