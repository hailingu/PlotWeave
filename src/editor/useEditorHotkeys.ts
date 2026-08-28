/**
 * 编辑器全局快捷键与失焦收起（docs/ui-design.md §4.3）。
 * document 级监听：⌘Z/⌘⇧Z/⌘Y 撤销重做、Delete/Backspace 删除选中
 * （节点优先于连线）、Escape 收起全部浮层；输入态（光标在输入控件内）
 * 时除 Escape 外全部放行；画布外 pointerdown 收起设置面板/＋菜单/右键菜单。
 */
import { useEffect, useRef } from 'react'

/** 快捷键动作集：删除选中前由调用方给出当前选中 id 列表（读画布镜像 ref）。 */
export interface EditorHotkeyActions {
  /** Escape：收起设置面板、＋菜单、右键菜单与导出对话框。 */
  onEscape: () => void
  /** 画布外 pointerdown：收起设置面板、＋菜单、右键菜单（失焦收起 §4.3）。 */
  onCloseTransient: () => void
  onUndo: () => void
  onRedo: () => void
  /** 当前选中节点/连线 id 列表（Delete 的删除对象，节点优先）。 */
  selectedNodeIds: () => string[]
  selectedEdgeIds: () => string[]
  onDeleteNodes: (ids: string[]) => void
  onDeleteEdges: (ids: string[]) => void
}

export function useEditorHotkeys(actions: EditorHotkeyActions): void {
  // 动作经 ref 读取：监听只挂一次，动作实现随渲染更新（等价于原 deps 重挂）。
  const ref = useRef(actions)
  ref.current = actions

  useEffect(() => {
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as HTMLElement
      if (!target.closest('[data-pw-settings],[data-pw-gear],.editor-plus,.editor-ctx')) {
        ref.current.onCloseTransient()
      }
    }
    const onKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement
      const typing = target.closest('input,textarea,select,[contenteditable="true"]')
      if (e.key === 'Escape') {
        ref.current.onEscape()
        return
      }
      if (typing) return
      const mod = e.metaKey || e.ctrlKey
      if (mod && e.key.toLowerCase() === 'z') {
        e.preventDefault()
        if (e.shiftKey) ref.current.onRedo()
        else ref.current.onUndo()
        return
      }
      if (mod && e.key.toLowerCase() === 'y') {
        e.preventDefault()
        ref.current.onRedo()
        return
      }
      if (e.key === 'Delete' || e.key === 'Backspace') {
        const nodeIds = ref.current.selectedNodeIds()
        if (nodeIds.length > 0) {
          e.preventDefault()
          ref.current.onDeleteNodes(nodeIds)
          return
        }
        const edgeIds = ref.current.selectedEdgeIds()
        if (edgeIds.length > 0) {
          e.preventDefault()
          ref.current.onDeleteEdges(edgeIds)
        }
      }
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [])
}
