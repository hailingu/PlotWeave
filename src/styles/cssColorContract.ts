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

/** CSS 静态具名色；currentColor 与系统色依赖环境，不能用于确定遮罩 alpha。 */
export function isNamedColor(value: string): boolean {
  return NAMED_COLORS.has(value.toLowerCase())
}

/** 声明是否含字面色（transparent 不计）；URL/字符串内容不属于颜色语法。 */
export function hasColorLiteral(value: string): boolean {
  const syntax = maskCssOpaque(value)
  if (COLOR_FUNCTION_OR_HEX.test(syntax)) return true
  for (const match of syntax.matchAll(BARE_IDENT)) {
    if (isNamedColor(match[0])) return true
  }
  return false
}

/** 已建模的简写关键字成分；完整简写顺序/互斥文法不由该集合证明。 */
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
  'double-circle',
  'triangle',
  'sesame',
  'padding-box',
  'border-box',
  'content-box',
])

/**
 * 按 docs/css-token-contract.md F3 验证完整顶层值：纯色/图像长形/描边有专门文法，
 * 其余简写逐成分检查，未知词形不能被颜色/图像掩盖；无绘制成分须为纯关键字。
 * 函数内部参数与完整简写顺序/互斥规则保留边界，不宣称等价于浏览器文法校验。
 */
export function colorTypeOk(prop: string, resolved: string): boolean {
  const value = resolved.trim()
  if (value === '') return false
  if (/^(inherit|initial|unset|revert|revert-layer)$/i.test(value)) return true
  if (prop === 'background-image' || prop === 'border-image-source')
    return imageValueOk(prop, value)
  if (prop === '-webkit-text-stroke') return textStrokeOk(value)
  if ((prop === 'fill' || prop === 'stroke') && /^url\(/i.test(value)) {
    const parts = postcss.list.space(value)
    return (
      imageKind(parts[0]!) === 'url' &&
      (parts.length === 1 ||
        (parts.length === 2 && completeColorAtom(parts[1]!)))
    )
  }
  if (
    prop === 'color' ||
    prop.endsWith('-color') ||
    prop === 'fill' ||
    prop === 'stroke'
  ) {
    return completeColorValueOk(prop, value)
  }
  return postcss.list
    .comma(value)
    .every((layer) => shorthandLayerOk(prop, layer))
}

/** 完整图像成分分类，供类型检查与黄金背景投影共用；函数参数保留既有边界。 */
export function imageKind(value: string): 'url' | 'gradient' | null {
  const match =
    /^(url|(?:repeating-)?(?:linear|radial|conic)-gradient)\(/i.exec(value)
  if (!match || colorTokenOf(value) !== value) return null
  return match[1]!.toLowerCase() === 'url' ? 'url' : 'gradient'
}

/** 图像长形只接受完整图像/none；保留空列表项以拒绝无效逗号，URL/函数内部逗号不分层。 */
function imageValueOk(prop: string, value: string): boolean {
  const syntax = maskCssOpaque(value)
  const images: string[] = []
  let depth = 0
  let start = 0
  for (let i = 0; i < syntax.length; i += 1) {
    if (syntax[i] === '(') depth += 1
    else if (syntax[i] === ')') depth -= 1
    else if (syntax[i] === ',' && depth === 0) {
      images.push(value.slice(start, i).trim())
      start = i + 1
    }
  }
  images.push(value.slice(start).trim())
  return (
    (prop === 'background-image' || images.length === 1) &&
    images.every((image) => /^none$/i.test(image) || imageKind(image) !== null)
  )
}

/** 简写的一层须消费全部顶层成分；图像的属性归属与未知词形在同一入口判定。 */
function shorthandLayerOk(prop: string, layer: string): boolean {
  const parts = postcss.list.space(layer)
  if (prop === 'border-image') {
    // 图像源没有颜色类型；通用简写关键字仅允许独立 none，不能掩盖错误成分。
    if (parts.some(completeColorAtom)) return false
    if (parts.some((part) => NON_COLOR_KEYWORDS.has(part.toLowerCase()))) {
      return parts.length === 1 && /^none$/i.test(parts[0]!)
    }
  }
  const acceptsImage = prop === 'background' || prop === 'border-image'
  const isPaint = (part: string): boolean =>
    completeColorAtom(part) || (acceptsImage && imageKind(part) !== null)
  const isKeyword = (part: string): boolean =>
    NON_COLOR_KEYWORDS.has(part.toLowerCase())
  const known = parts.every(
    (part) => isPaint(part) || isKeyword(part) || isLineWidth(part),
  )
  return (
    parts.length > 0 && known && (parts.some(isPaint) || parts.every(isKeyword))
  )
}

/** 类型检查与背景投影共用的完整颜色成分识别；不计算 RGBA，函数参数仍保留边界。 */
export function completeColorAtom(value: string): boolean {
  if (/^#(?:[\da-f]{3,4}|[\da-f]{6}|[\da-f]{8})$/i.test(value)) return true
  if (isNamedColor(value) || /^(transparent|currentcolor)$/i.test(value))
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
