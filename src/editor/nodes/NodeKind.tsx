import type { ReactNode } from 'react'
import type { CanvasNode } from './types'

/** 内容类型线条符号；各类型通过图形和文字区分，不依赖专属底色。 */
const KINDS = {
  scene: {
    label: '场景',
    path: 'M4 4h16v16H4z M4 8h16 M8 4v4 M13 4v4 M18 4v4',
  },
  dialogue: { label: '对白', path: 'M4 4h16v12H9l-5 4z M8 8h8 M8 12h5' },
  beat: { label: '节奏卡', path: 'm13 3-8 10h6l-1 8 9-11h-6z' },
  branch: {
    label: '分支',
    path: 'M6 17V8a4 4 0 0 1 4-4h5 M6 10h8a4 4 0 0 1 4 4v3 M3 18a3 3 0 1 0 6 0 3 3 0 0 0-6 0 M15 18a3 3 0 1 0 6 0 3 3 0 0 0-6 0 M15 4a3 3 0 1 0 6 0 3 3 0 0 0-6 0',
  },
  shot: {
    label: '分镜',
    path: 'M3 6h18v14H3z M3 10h18 M7 6l3 4 M14 6l3 4 M10 13l5 2-5 2z',
  },
  image: {
    label: '图片',
    path: 'M4 4h16v16H4z M4 16l5-5 4 4 3-3 4 4 M15 8h.01',
  },
} satisfies Record<
  NonNullable<CanvasNode['type']>,
  { label: string; path: string }
>

/** 共享类型栏：次级图标／标签、派生摘要与宿主既有设置入口。 */
export function NodeKind({
  kind,
  detail,
  children,
}: {
  readonly kind: NonNullable<CanvasNode['type']>
  readonly detail?: ReactNode
  readonly children?: ReactNode
}) {
  const { label, path } = KINDS[kind]
  return (
    <div className="pw-node-kind">
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
        <path d={path} />
      </svg>
      <span>{label}</span>
      <span className="pw-sp" />
      {detail && <span className="pw-node-detail">{detail}</span>}
      {children}
    </div>
  )
}
