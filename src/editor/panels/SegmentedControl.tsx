/**
 * macOS 风格分段控件（docs/ui-design.md §3.4）：
 * 左栏「大纲 / 设定集 / 资产」与右栏「检查器 / ✦AI」共用的分段切换。
 * 纯展示结构组件——选中态由父组件持有，选项以 value/label 对传入。
 */
export interface SegmentOption<T extends string> {
  value: T
  label: string
}

interface SegmentedControlProps<T extends string> {
  /** 无障碍分组名（如「左栏分段」）。 */
  readonly groupLabel: string
  readonly options: SegmentOption<T>[]
  readonly value: T
  readonly onChange: (value: T) => void
}

export default function SegmentedControl<T extends string>({
  groupLabel,
  options,
  value,
  onChange,
}: SegmentedControlProps<T>) {
  return (
    // 原生 fieldset 承载分组语义（S6819）；UA 边框/外距在 .pw-seg 重置
    <fieldset className="pw-seg" aria-label={groupLabel}>
      {options.map((opt) => (
        <button
          key={opt.value}
          type="button"
          className={`pw-seg-item${opt.value === value ? ' pw-seg-item-on' : ''}`}
          aria-pressed={opt.value === value}
          onClick={() => onChange(opt.value)}
        >
          {opt.label}
        </button>
      ))}
    </fieldset>
  )
}
