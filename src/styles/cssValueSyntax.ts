/**
 * CSS 值中不透明内容的词法边界：颜色检测、变量依赖及替换共用。
 * 输入原始声明值，输出等长语法视图；原值由调用方保留，未闭合内容屏蔽到末尾。
 * 不验证完整 CSS 文法，不解析字符串或 URL 内的变量与颜色。
 * 注释不在此屏蔽：调用方传入的是 PostCSS decl.value，注释已被剥离。
 */

/** 跳过引号字符串或 URL 内容，保留转义字符和 URL 内引号的边界语义。 */
function opaqueEnd(value: string, start: number, closing: string): number {
  let i = start
  while (i < value.length) {
    const char = value[i]
    if (char === '\\') i += 2
    else if (char === closing) return i + 1
    else if (closing === ')' && (char === '"' || char === "'")) {
      i = opaqueEnd(value, i + 1, char)
    } else i += 1
  }
  return value.length
}

/** 将字符串与 URL 内容替换为等长空格，供颜色/变量扫描共用并保持原始值的切片偏移。 */
export function maskCssOpaque(value: string): string {
  let syntax = ''
  for (let i = 0; i < value.length;) {
    const char = value[i] ?? ''
    const url =
      value.slice(i, i + 4).toLowerCase() === 'url(' &&
      !/[\w\u0080-\uFFFF-]/.test(value[i - 1] ?? '')
    const start = i
    if (char === '"' || char === "'") {
      i = opaqueEnd(value, i + 1, char)
    } else if (url) {
      i = opaqueEnd(value, i + 4, ')')
    } else {
      syntax += char
      i += 1
      continue
    }
    syntax += ' '.repeat(i - start)
  }
  return syntax
}

/**
 * CSS 空白集（空格/制表/换行/回车/换页）裁剪，供名称/关键字等词法入口
 * 共用同一空白语义。不用 JS `.trim()`：其空白集更大，会把名称末端的
 * NBSP 等有效非 ASCII 码点误当空白移除（F5-c「自定义属性名按原始码点
 * 序列匹配」，issue #289），也会把 NBSP 包围的关键字取值误判为 CSS-wide
 * 关键字（issue #339）。
 */
export function trimCssWhitespace(value: string): string {
  return value.replace(/^[ \t\n\r\f]+/, '').replace(/[ \t\n\r\f]+$/, '')
}

/**
 * 顶层成分切分内核（引号/括号/转义不透明内容不切分），遍历与收尾结构对齐
 * postcss.list.split：成分入列按 CSS 空白集裁剪而非 JS trim（NBSP 等非
 * CSS 空白码点是内容，不得丢失或折算成关键字，issue #339 评审）；空格
 * 分隔符补齐回车/换页。`keepTrailing` 对齐 postcss 的 last 语义：逗号
 * 收尾恒入列（尾逗号产生空成分，交由消费方拒绝），空格收尾仅非空入列。
 */
function splitTopLevel(
  value: string,
  separators: string[],
  keepTrailing: boolean,
): string[] {
  const items: string[] = []
  let current = ''
  let split = false
  let depth = 0
  let quote: string | null = null
  let escaped = false
  for (const char of value) {
    if (escaped) escaped = false
    else if (char === '\\') escaped = true
    else if (quote !== null) {
      if (char === quote) quote = null
    } else if (char === '"' || char === "'") quote = char
    else if (char === '(') depth += 1
    else if (char === ')') {
      if (depth > 0) depth -= 1
    } else if (depth === 0 && separators.includes(char)) split = true

    if (split) {
      if (current !== '') items.push(trimCssWhitespace(current))
      current = ''
      split = false
    } else {
      current += char
    }
  }
  if (keepTrailing || current !== '') items.push(trimCssWhitespace(current))
  return items
}

/** CSS 空白集（空格/制表/换行/回车/换页）分隔的顶层成分。 */
export function splitCssSpace(value: string): string[] {
  return splitTopLevel(value, [' ', '\t', '\n', '\r', '\f'], false)
}

/** 逗号分隔的顶层成分列表（括号/引号内不切分）。 */
export function splitCssComma(value: string): string[] {
  return splitTopLevel(value, [','], true)
}
