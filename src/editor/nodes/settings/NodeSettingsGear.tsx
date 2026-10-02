/**
 * 节点设置齿轮按钮（issue #105）：六类节点（beat/dialogue/scene/branch/
 * shot/image）常驻 ⚙️ 的统一实现（docs/ui-design.md §4.3，编辑即命令）。
 * 纯展示组件：打开状态与切换回调由调用方（useNodeEdit 的
 * openSettingsId / toggleSettings）注入，aria-expanded 因此与设置面板
 * 开合始终一致。点击阻止冒泡，避免触发画布拖动/画布级点击；
 * light 变体用于纸面节点，默认变体用于深色石板节点。
 */
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
  /** 切换设置面板开合；组件内不捕获节点 id，由调用方闭包绑定。 */
  readonly onToggle: () => void
  /** 纸面浅色外观变体；缺省为深色石板外观。 */
  readonly light?: boolean
}) {
  return (
    <button
      type="button"
      className={`pw-gear${light ? ' pw-gear-light' : ''} nodrag${open ? ' pw-gear-open' : ''}`}
      data-pw-gear
      aria-label={ariaLabel}
      aria-expanded={open}
      onClick={(e) => {
        e.stopPropagation()
        onToggle()
      }}
    >
      ⚙️
    </button>
  )
}
