/**
 * 节点设置齿轮按钮（issue #105）：六类节点（beat/dialogue/scene/branch/
 * shot/image）常驻单色线条齿轮的统一实现（docs/ui-design.md §4.3，编辑即命令）。
 * 纯展示组件：打开状态与切换回调由调用方（useNodeEdit 的
 * openSettingsId / toggleSettings）注入，aria-expanded 表示当前属性目标。
 * Swift 通过节点点击进入原生检查器，隐藏本按钮；其他宿主切换内联面板。
 * 点击阻止冒泡，避免
 * 触发画布拖动/画布级点击；
 * light 变体用于纸面节点，默认变体用于深色石板节点。
 */
import { isSwiftHost } from '../../../platform/hostEnvironment'

/** 浏览器与 Tauri 的内联属性入口；Swift 由节点点击进入原生检查器。 */
export function NodeSettingsGear({
  ariaLabel,
  open,
  onToggle,
  light = false,
}: {
  /** 可访问名称，按节点类型区分（如「节奏卡设置」「分镜设置」）。 */
  readonly ariaLabel: string
  /** 设置面板是否打开（openSettingsId === 节点 id）。 */
  readonly open: boolean
  /** 请求节点属性；组件内不捕获节点 id，由调用方闭包绑定宿主动作。 */
  readonly onToggle: () => void
  /** 纸面浅色外观变体；缺省为深色石板外观。 */
  readonly light?: boolean
}) {
  if (isSwiftHost()) return null
  return (
    <button
      type="button"
      className={`pw-gear${light ? ' pw-gear-light' : ''} nodrag${open ? ' pw-gear-open' : ''}`}
      data-pw-gear
      aria-label={ariaLabel}
      aria-expanded={open}
      title={ariaLabel}
      onClick={(e) => {
        e.stopPropagation()
        onToggle()
      }}
    >
      <svg
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        focusable="false"
      >
        <path d="M10.44 3.14 L13.56 3.14 L14.05 5.31 L15.29 5.82 L17.16 4.63 L19.37 6.84 L18.18 8.71 L18.69 9.95 L20.86 10.44 L20.86 13.56 L18.69 14.05 L18.18 15.29 L19.37 17.16 L17.16 19.37 L15.29 18.18 L14.05 18.69 L13.56 20.86 L10.44 20.86 L9.95 18.69 L8.71 18.18 L6.84 19.37 L4.63 17.16 L5.82 15.29 L5.31 14.05 L3.14 13.56 L3.14 10.44 L5.31 9.95 L5.82 8.71 L4.63 6.84 L6.84 4.63 L8.71 5.82 L9.95 5.31Z" />
        <circle cx="12" cy="12" r="3.25" />
      </svg>
    </button>
  )
}
