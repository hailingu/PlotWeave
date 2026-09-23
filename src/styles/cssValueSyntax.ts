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
