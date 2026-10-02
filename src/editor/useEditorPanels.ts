/**
 * 编辑器面板与瞬态浮层状态（EditorView 拆出的 UI 状态域，docs/ui-design.md
 * §3.4/§4.3/§5）：三栏显隐与宽度、右栏页、⚙️ 设置面板、＋节点下拉、导出
 * 对话框、右键菜单与设定文档编辑弹窗（issue #126 状态提升）。失焦收起所
 * 需的两个批量关闭回调也收口在此，供快捷键 hook 直接消费（Escape 连导出
 * 对话框一起收，画布外 pointerdown 只收瞬态浮层）。
 */
import {
  useCallback,
  useState,
  type Dispatch,
  type SetStateAction,
} from 'react'
import type { RightTab } from './panels/RightPanel'

/** 左右栏初始宽度（§3.4 可调区间 220–320pt 的居中默认值）。 */
const DEFAULT_LEFT_WIDTH = 248
const DEFAULT_RIGHT_WIDTH = 264

/** 右键菜单触发态：视口坐标 + 命中的节点或连线 id（空白菜单两者皆无）。 */
export interface ContextMenuState {
  x: number
  y: number
  nodeId?: string
  edgeId?: string
}

/** 面板与浮层状态及其开关动作；宽度为像素，显隐与会话同生命周期。 */
export interface EditorPanels {
  leftOpen: boolean
  setLeftOpen: Dispatch<SetStateAction<boolean>>
  leftWidth: number
  setLeftWidth: Dispatch<SetStateAction<number>>
  rightOpen: boolean
  setRightOpen: Dispatch<SetStateAction<boolean>>
  rightWidth: number
  setRightWidth: Dispatch<SetStateAction<number>>
  rightTab: RightTab
  setRightTab: Dispatch<SetStateAction<RightTab>>
  openSettingsId: string | null
  toggleSettings: (id: string) => void
  closeSettings: () => void
  plusOpen: boolean
  setPlusOpen: Dispatch<SetStateAction<boolean>>
  exportOpen: boolean
  setExportOpen: Dispatch<SetStateAction<boolean>>
  ctxMenu: ContextMenuState | null
  setCtxMenu: Dispatch<SetStateAction<ContextMenuState | null>>
  /** 正在编辑的设定文档 id（issue #126 状态提升）：null = 弹窗关闭。
   * 快捷键层据此挂起全局撤销/重做，见 useEditorHotkeys。 */
  editingDocId: string | null
  /** 打开设定文档编辑弹窗（SettingsList 行点击）。 */
  openDocument: (id: string) => void
  /** 关闭设定文档编辑弹窗（Esc/遮罩/保存/关闭按钮）。 */
  closeDocument: () => void
  toggleRight: (tab: RightTab) => void
  /** 画布外 pointerdown：收起设置面板、＋菜单与右键菜单（§4.3 失焦收起）。 */
  closeTransient: () => void
  /** Escape：在上述基础上连导出对话框一起收起。 */
  closeAllTransient: () => void
}

/** 三栏与瞬态浮层的状态容器；不含任何画布文档写入。 */
export function useEditorPanels(): EditorPanels {
  // 三栏面板状态（§3.4：220–320pt 可调，显隐会话内记忆——组件态即会话态）
  const [leftOpen, setLeftOpen] = useState(true)
  const [leftWidth, setLeftWidth] = useState(DEFAULT_LEFT_WIDTH)
  const [rightOpen, setRightOpen] = useState(true)
  const [rightWidth, setRightWidth] = useState(DEFAULT_RIGHT_WIDTH)
  const [rightTab, setRightTab] = useState<RightTab>('inspector')
  // ⚙️ 设置面板、＋节点下拉、右键菜单与导出对话框（§4.3：失焦收起）
  const [openSettingsId, setOpenSettingsId] = useState<string | null>(null)
  const [plusOpen, setPlusOpen] = useState(false)
  const [exportOpen, setExportOpen] = useState(false)
  const [ctxMenu, setCtxMenu] = useState<ContextMenuState | null>(null)

  const toggleSettings = useCallback((id: string) => {
    setOpenSettingsId((cur) => (cur === id ? null : id))
  }, [])
  const closeSettings = useCallback(() => setOpenSettingsId(null), [])

  // 设定文档编辑弹窗（issue 56；issue #126 从左栏局部状态提升）：
  // 全局快捷键需要感知模态会话以挂起撤销/重做
  const [editingDocId, setEditingDocId] = useState<string | null>(null)
  const openDocument = useCallback((id: string) => setEditingDocId(id), [])
  const closeDocument = useCallback(() => setEditingDocId(null), [])

  /** 右栏页切换：同页再点收起，异页直接切换并展开。 */
  const toggleRight = useCallback(
    (tab: RightTab) => {
      setRightTab(tab)
      setRightOpen(rightTab !== tab || !rightOpen)
    },
    [rightTab, rightOpen],
  )

  const closeTransient = useCallback(() => {
    setOpenSettingsId(null)
    setPlusOpen(false)
    setCtxMenu(null)
  }, [])
  const closeAllTransient = useCallback(() => {
    setOpenSettingsId(null)
    setPlusOpen(false)
    setCtxMenu(null)
    setExportOpen(false)
  }, [])

  return {
    leftOpen,
    setLeftOpen,
    leftWidth,
    setLeftWidth,
    rightOpen,
    setRightOpen,
    rightWidth,
    setRightWidth,
    rightTab,
    setRightTab,
    openSettingsId,
    toggleSettings,
    closeSettings,
    plusOpen,
    setPlusOpen,
    exportOpen,
    setExportOpen,
    ctxMenu,
    setCtxMenu,
    editingDocId,
    openDocument,
    closeDocument,
    toggleRight,
    closeTransient,
    closeAllTransient,
  }
}
