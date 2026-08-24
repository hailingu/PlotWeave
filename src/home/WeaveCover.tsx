import { useId } from 'react'

/**
 * 「织线」兜底封面：项目未选定封面时，用发光节点与分叉线的抽象图
 * 呼应 PlotWeave 之名（docs/ui-design.md §3.2）。
 * 纯展示组件，随海报尺寸缩放。
 */
export default function WeaveCover() {
  const gradientId = useId()
  return (
    <svg
      className="weave-cover"
      viewBox="0 0 60 80"
      role="img"
      aria-label="织线兜底封面"
    >
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#21d4fd" />
          <stop offset="1" stopColor="#ff2e88" />
        </linearGradient>
      </defs>
      <path
        d="M8 40 C 22 40 22 18 40 18 M8 40 C 22 40 22 62 40 62 M40 18 C 48 18 48 40 54 40 M40 62 C 48 62 48 40 54 40"
        stroke={`url(#${gradientId})`}
        strokeWidth="1.5"
        fill="none"
        opacity="0.9"
      />
      <circle cx="8" cy="40" r="2.4" fill="#21d4fd" />
      <circle cx="40" cy="18" r="2" fill="#7f6cf0" />
      <circle cx="40" cy="62" r="2" fill="#7f6cf0" />
      <circle cx="54" cy="40" r="2.4" fill="#ff2e88" />
    </svg>
  )
}
