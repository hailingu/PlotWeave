import type { NodeGlyphName } from './NodeGlyph'

/** 仅识别字段开头的既有装饰；未知文字和文本中部符号保持原样。 */
const PREFIXES = {
  time: [
    ['🌙', 'moon'],
    ['☀', 'sun'],
    ['🌅', 'sun'],
  ],
  weather: [
    ['🌧', 'rain'],
    ['☔', 'rain'],
    ['🌦', 'rain'],
    ['❄', 'snow'],
    ['🌨', 'snow'],
    ['💨', 'wind'],
    ['☀', 'sun'],
    ['🌤', 'sun'],
    ['⛅', 'cloud'],
    ['☁', 'cloud'],
  ],
} as const satisfies Record<
  string,
  readonly (readonly [string, NodeGlyphName])[]
>

/** 普通中文值的符号映射；自由文本使用时间／天气的通用线条符号。 */
const PLAIN: Readonly<Record<string, NodeGlyphName>> = {
  夜: 'moon',
  日: 'sun',
  白天: 'sun',
  晴: 'sun',
  雨: 'rain',
  雪: 'snow',
  风: 'wind',
  阴: 'cloud',
  多云: 'cloud',
}

/** 场景属性的显示值，不回写模型或改变保存字段。 */
export interface SceneAttribute {
  readonly label: string
  readonly icon: NodeGlyphName
}

/** 历史 Emoji 前缀只转换为装饰图标；空值不展示，未知自由文本不删改。 */
export function sceneAttribute(
  kind: 'time' | 'weather',
  value: string,
): SceneAttribute | null {
  if (!value.trim()) return null
  for (const [prefix, icon] of PREFIXES[kind]) {
    if (!value.startsWith(prefix)) continue
    const label = value
      .slice(prefix.length)
      .replace(/^[\uFE0E\uFE0F]/u, '')
      .trimStart()
    if (label.trim()) return { label, icon }
  }
  const defaultIcon = kind === 'time' ? 'clock' : 'cloud'
  const icon = Object.prototype.hasOwnProperty.call(PLAIN, value)
    ? PLAIN[value]!
    : defaultIcon
  return { label: value, icon }
}
