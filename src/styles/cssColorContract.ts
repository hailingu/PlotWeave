/**
 * 样式令牌契约的 CSS 值校验：字面色探测、完整颜色成分与已建模属性类型。
 * 供全表契约和语义夹具共用，不解析完整 CSS 文法或运行时层叠。
 */
import postcss from 'postcss'
import { maskCssOpaque } from './cssValueSyntax'

/** 取完整 CSS 函数或首个空白分隔成分，供颜色、遮罩及 var() 解析共用。 */
export function colorTokenOf(part: string): string {
  if (!/^[\w-]+\(/.test(part)) return part.split(/\s+/)[0]!
  const opening = part.indexOf('(') + 1
  const syntax = part.slice(0, opening) + maskCssOpaque(part.slice(opening))
  let depth = 0
  for (let i = 0; i < part.length; i += 1) {
    if (syntax[i] === '(') depth += 1
    else if (syntax[i] === ')') {
      depth -= 1
      if (depth === 0) return part.slice(0, i + 1)
    }
  }
  throw new Error(`色标函数未闭合: ${part}`)
}

/** CSS 函数名大小写不敏感（`RGB(...)` 与 `rgb(...)` 同为字面函数色）。 */
const COLOR_FUNCTION_OR_HEX =
  /#[0-9a-f]{3,8}\b|\brgba?\(|\bhsla?\(|\bhwb\(|\blab\(|\blch\(|\boklab\(|\boklch\(|\bcolor\(/i

/** CSS Color 4 全部具名色（148）；transparent/currentcolor 为关键字，不在此列。 */
const NAMED_COLORS = new Set(
  (
    'aliceblue antiquewhite aqua aquamarine azure beige bisque black ' +
    'blanchedalmond blue blueviolet brown burlywood cadetblue chartreuse ' +
    'chocolate coral cornflowerblue cornsilk crimson cyan darkblue darkcyan ' +
    'darkgoldenrod darkgray darkgreen darkgrey darkkhaki darkmagenta ' +
    'darkolivegreen darkorange darkorchid darkred darksalmon darkseagreen ' +
    'darkslateblue darkslategray darkslategrey darkturquoise darkviolet ' +
    'deeppink deepskyblue dimgray dimgrey dodgerblue firebrick floralwhite ' +
    'forestgreen fuchsia gainsboro ghostwhite gold goldenrod gray green ' +
    'greenyellow grey honeydew hotpink indianred indigo ivory khaki lavender ' +
    'lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan ' +
    'lightgoldenrodyellow lightgray lightgreen lightgrey lightpink ' +
    'lightsalmon lightseagreen lightskyblue lightslategray lightslategrey ' +
    'lightsteelblue lightyellow lime limegreen linen magenta maroon ' +
    'mediumaquamarine mediumblue mediumorchid mediumpurple mediumseagreen ' +
    'mediumslateblue mediumspringgreen mediumturquoise mediumvioletred ' +
    'midnightblue mintcream mistyrose moccasin navajowhite navy oldlace ' +
    'olive olivedrab orange orangered orchid palegoldenrod palegreen ' +
    'paleturquoise palevioletred papayawhip peachpuff peru pink plum ' +
    'powderblue purple rebeccapurple red rosybrown royalblue saddlebrown ' +
    'salmon sandybrown seagreen seashell sienna silver skyblue slateblue ' +
    'slategray slategrey snow springgreen steelblue tan teal thistle tomato ' +
    'turquoise violet wheat white whitesmoke yellow yellowgreen'
  ).split(' '),
)

/** 独立标识符（非 var(--name) 片段、非函数名、非带单位数字）。 */
const BARE_IDENT = /(?<![\w-])[a-zA-Z]+(?![\w-(])/g

/** 声明是否含字面色（transparent 不计）；URL/字符串内容不属于颜色语法。 */
export function hasColorLiteral(value: string): boolean {
  const syntax = maskCssOpaque(value)
  if (COLOR_FUNCTION_OR_HEX.test(syntax)) return true
  for (const match of syntax.matchAll(BARE_IDENT)) {
    if (NAMED_COLORS.has(match[0].toLowerCase())) return true
  }
  return false
}

const DIMENSION = /\b\d+(?:\.\d+)?(?:px|em|rem|%|pt|vw|vh|ch|ex)\b/

/** 不带单位/百分号的裸数值（如字重 600）——对展示色属性必为类型不相容。 */
const BARE_NUMBER = /(?<![\w.])\d+(?:\.\d+)?(?![\w.%])/

/** 展示色属性合法的非颜色关键字形态（背景/边框/线型的关键字与通用关键字）。 */
const NON_COLOR_KEYWORDS = new Set([
  'none',
  'inherit',
  'initial',
  'unset',
  'revert',
  'transparent',
  'currentcolor',
  'solid',
  'dashed',
  'dotted',
  'double',
  'wavy',
  'underline',
  'overline',
  'line-through',
  'blink',
  'thick',
  'thin',
  'medium',
  'filled',
  'open',
  'dot',
  'circle',
  'triangle',
  'sesame',
])

/**
 * 展示色声明解析值对该属性是否类型相容：仅 background/background-image/
 * border-image(-source) 接受渐变，URL 还可用于 SVG fill/stroke 绘制引用；
 * 其他属性先拒图像，纯颜色属性随后检查完整顶层值，其他简写检查颜色成分；
 * 无颜色成分时须为「无尺寸量、无裸数值、全部词形在非颜色关键字表内」的
 * 纯关键字形态（none/underline/solid 等）——尺寸量（--radius-sm 的 4px）、
 * 裸数值（--weight 的 600）及未识别词形均按类型不相容点名。
 */
export function colorTypeOk(prop: string, resolved: string): boolean {
  if (resolved.trim() === '') return false
  if (prop === '-webkit-text-stroke') return textStrokeOk(resolved.trim())
  const acceptsImage =
    prop === 'background' ||
    prop === 'background-image' ||
    prop === 'border-image' ||
    prop === 'border-image-source'
  if (/(?:linear|radial|conic)-gradient\(/i.test(resolved)) return acceptsImage
  if (/url\(/i.test(resolved))
    return acceptsImage || prop === 'fill' || prop === 'stroke'
  if (
    prop === 'color' ||
    prop.endsWith('-color') ||
    prop === 'fill' ||
    prop === 'stroke'
  ) {
    return completeColorValueOk(prop, resolved.trim())
  }
  if (COLOR_FUNCTION_OR_HEX.test(resolved)) return true
  if (/transparent|currentcolor/i.test(resolved)) return true
  for (const match of resolved.matchAll(BARE_IDENT)) {
    if (NAMED_COLORS.has(match[0].toLowerCase())) return true
  }
  if (DIMENSION.test(resolved) || BARE_NUMBER.test(resolved)) return false
  return [...resolved.matchAll(BARE_IDENT)].every((match) =>
    NON_COLOR_KEYWORDS.has(match[0].toLowerCase()),
  )
}

/** 单个颜色成分须完整匹配；函数内部参数仍交给既有静态模型边界。 */
function completeColorAtom(value: string): boolean {
  if (/^#(?:[\da-f]{3,4}|[\da-f]{6}|[\da-f]{8})$/i.test(value)) return true
  if (
    NAMED_COLORS.has(value.toLowerCase()) ||
    /^(transparent|currentcolor)$/i.test(value)
  )
    return true
  const prefix = COLOR_FUNCTION_OR_HEX.exec(value)
  return (
    prefix?.index === 0 &&
    !value.startsWith('#') &&
    colorTokenOf(value) === value
  )
}

/** 纯颜色属性只接受完整值；边框颜色列表按四向/逻辑双向的既有语法保留。 */
function completeColorValueOk(prop: string, value: string): boolean {
  if (/^(inherit|initial|unset|revert|revert-layer)$/i.test(value)) return true
  if (
    (prop === 'fill' || prop === 'stroke') &&
    /^(none|context-fill|context-stroke)$/i.test(value)
  )
    return true
  if (
    (prop === 'caret-color' ||
      prop === 'accent-color' ||
      prop === 'scrollbar-color') &&
    /^auto$/i.test(value)
  )
    return true
  let max = 1
  if (prop === 'border-color') max = 4
  else if (
    prop === 'scrollbar-color' ||
    /^border-(inline|block)-color$/.test(prop)
  )
    max = 2
  const colors = postcss.list.space(value)
  return (
    colors.length > 0 && colors.length <= max && colors.every(completeColorAtom)
  )
}

const LENGTH = /^(?:\d+(?:\.\d+)?|\.\d+)(?:px|r?em|pt|ch|ex|v[wh])$/i

/** 线宽：0、常用长度单位或 thin/medium/thick。 */
function isLineWidth(part: string): boolean {
  return (
    part === '0' || /^(?:thin|medium|thick)$/i.test(part) || LENGTH.test(part)
  )
}

/** `-webkit-text-stroke: <line-width> || <color>`：至多一个宽度与一个完整颜色成分，无其他词形。 */
function textStrokeOk(value: string): boolean {
  if (/^(inherit|initial|unset|revert|revert-layer)$/i.test(value)) return true
  const parts = postcss.list.space(value)
  const widths = parts.filter(isLineWidth).length
  const colors = parts.filter(completeColorAtom).length
  return (
    parts.length > 0 &&
    widths <= 1 &&
    colors <= 1 &&
    widths + colors === parts.length
  )
}
