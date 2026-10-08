/** 节点摘要与引用位共用的单色线条路径；沿用类型栏的 1.5pt 描边。 */
const PATHS = {
  pin: 'M12 21s7-6 7-12a7 7 0 0 0-14 0c0 6 7 12 7 12z M9 9a3 3 0 1 0 6 0 3 3 0 0 0-6 0',
  clock: 'M3 12a9 9 0 1 0 18 0 9 9 0 0 0-18 0 M12 7v5l3 2',
  moon: 'M20 14A9 9 0 0 1 10 4a9 9 0 1 0 10 10z',
  sun: 'M8 12a4 4 0 1 0 8 0 4 4 0 0 0-8 0 M12 2v2 M12 20v2 M2 12h2 M20 12h2 M5 5l1.5 1.5 M17.5 17.5 19 19 M5 19l1.5-1.5 M17.5 6.5 19 5',
  cloud: 'M6 18a4 4 0 0 1-1-8 6 6 0 0 1 11-2 5 5 0 1 1 2 10z',
  rain: 'M5 14a4 4 0 0 1 0-8 5 5 0 0 1 9-1 4 4 0 1 1 4 9z M7 17l-1 3 M12 17l-1 3 M17 17l-1 3',
  snow: 'M12 3v18 M4 7l16 10 M4 17 20 7 M9 5l3 3 3-3 M9 19l3-3 3 3 M5 10l4-1-1-4 M16 19l-1-4 4-1 M5 14l4 1-1 4 M16 5l-1 4 4 1',
  wind: 'M3 8h12a3 3 0 1 0-3-3 M3 12h16a3 3 0 1 1-3 3 M3 16h7a3 3 0 1 1-3 3',
  character: 'M8 7a4 4 0 1 0 8 0 4 4 0 0 0-8 0 M4 21v-3a8 8 0 0 1 16 0v3z',
  location: 'M3 4h18v16H3z M3 16l5-5 5 5 3-3 5 5 M14 8h.01',
  audio:
    'M9 17V5l11-2v12 M9 8l11-2 M3 18a3 2 0 1 0 6 0 3 2 0 0 0-6 0 M14 16a3 2 0 1 0 6 0 3 2 0 0 0-6 0',
  warning: 'm12 3 10 18H2z M12 9v5 M12 17h.01',
} as const

/** 允许的内容符号名称；颜色与辅助技术名称由承载标签拥有。 */
export type NodeGlyphName = keyof typeof PATHS

/** 装饰符号跟随文字颜色；14pt 方形几何避免 Emoji 字形和基线差异。 */
export function NodeGlyph({ name }: { readonly name: NodeGlyphName }) {
  return (
    <svg
      className="pw-node-glyph"
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d={PATHS[name]} />
    </svg>
  )
}
