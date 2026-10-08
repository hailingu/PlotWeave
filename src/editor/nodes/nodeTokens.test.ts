/** 原生内容卡的颜色配对与外置端口样式合同（docs/ui-design.md §2.3／§4.3／§4.5）。
 * 解析真实 CSS，验证语义色、尺寸稳定和箭头布局；实际像素几何由浏览器补足。
 * 角色头像沿用用户内容配色，不纳入确定性颜色配对；普通边与常态装饰描边
 * 不要求 3:1，增强对比度下边与端口必须达到此值。
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import postcss from 'postcss'
import { describe, expect, it } from 'vitest'
import {
  LIGHT_ENV,
  tokenValues,
  resolveChain,
  ruleIn,
  declOf,
  type Env,
} from '../../styles/sheetTokensEngine'

const root = join(dirname(fileURLToPath(import.meta.url)), '../../..')
const css = postcss.parse(
  readFileSync(join(root, 'src/editor/nodes/nodes.css'), 'utf8'),
)
const ports = postcss.parse(
  readFileSync(join(root, 'src/editor/nodes/ports.css'), 'utf8'),
)

/** 新内容卡使用不透明语义色；拒绝透明或未知颜色，防错误配对被略过。 */
function rgb(token: string, values: Map<string, string>): number[] {
  const value = resolveChain(`var(${token})`, values)
  if (!/^#[a-f0-9]{6}$/i.test(value))
    throw new Error(`内容卡颜色不是不透明六位色：${token}=${value}`)
  return [1, 3, 5].map((start) => parseInt(value.slice(start, start + 2), 16))
}

/** WCAG 相对亮度，以实际解析颜色计算，不以令牌名代替对比度。 */
function luminance(color: number[]): number {
  const linear = color.map((channel) => {
    const v = channel / 255
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
  })
  return linear[0]! * 0.2126 + linear[1]! * 0.7152 + linear[2]! * 0.0722
}

/** 非文本／文本配对使用同一亮度公式。 */
function contrast(fg: string, bg: string, values: Map<string, string>): number {
  const a = luminance(rgb(fg, values)),
    b = luminance(rgb(bg, values))
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
}

const ENVS: Env[] = (['light', 'dark'] as const).flatMap((scheme) =>
  (['no-preference', 'more'] as const).map((contrast) => ({
    ...LIGHT_ENV,
    scheme,
    contrast,
  })),
)

/** CSS 属性解析入口，共享合同解析器；未找到规则或属性必须失败。 */
function style(selector: string, property: string, sheet = css): string {
  const base = sheet.clone()
  base.walkAtRules((rule) => {
    rule.remove()
  })
  return declOf(ruleIn(base, '内容卡样式', selector), property)
}

describe('原生内容卡语义颜色', () => {
  it.each(ENVS)(
    '$scheme / $contrast：正文、次级文字与选中标签均达到 4.5:1',
    (env) => {
      const values = tokenValues(env)
      for (const bg of ['--node-card', '--node-fill']) {
        for (const fg of ['--node-text', '--node-secondary']) {
          expect(
            contrast(fg, bg, values),
            `${fg} on ${bg}`,
          ).toBeGreaterThanOrEqual(4.5)
        }
      }
      expect(
        contrast('--node-accent', '--node-accent-soft', values),
      ).toBeGreaterThanOrEqual(4.5)
    },
  )

  it('六类卡片共用随外观适配的面与前景，选中不改变盒子尺寸', () => {
    expect(style('.pw-card', 'background')).toBe('var(--node-card)')
    expect(style('.pw-card', 'color')).toBe('var(--node-text)')
    const selected = ruleIn(css, '内容卡样式', '.pw-card.pw-on')
    expect(declOf(selected, 'border-color')).toBe('var(--node-accent)')
    expect(declOf(selected, 'outline')).toBe('1px solid var(--node-accent)')
    const geometry = selected.nodes.filter(
      (n) =>
        n.type === 'decl' &&
        [
          'width',
          'height',
          'padding',
          'border',
          'border-width',
          'transform',
        ].includes(n.prop),
    )
    expect(geometry).toEqual([])
    expect(
      tokenValues({ ...LIGHT_ENV, scheme: 'dark' }).get('--node-card'),
    ).not.toBe(tokenValues(LIGHT_ENV).get('--node-card'))
  })

  it.each(ENVS.filter((env) => env.contrast === 'more'))(
    '$scheme：增强对比度边、端口与卡框 ≥ 3:1',
    (env) => {
      const values = tokenValues(env)
      for (const fg of [
        '--edge-sequence',
        '--node-port-ring',
        '--node-border',
      ]) {
        expect(contrast(fg, '--surface-canvas', values)).toBeGreaterThanOrEqual(
          3,
        )
      }
    },
  )
})

describe('外置端口样式合同', () => {
  it('28pt 命中区承载 14pt 图形，圆形输入与方形输出不同', () => {
    expect(style('.react-flow__handle.pw-port', 'width', ports)).toBe('14px')
    expect(style('.react-flow__handle.pw-port::before', 'height', ports)).toBe(
      '28px',
    )
    expect(style('.pw-port-mark', 'width', ports)).toBe('14px')
    expect(style('.pw-port-mark', 'height', ports)).toBe('14px')
    expect(style('.pw-port-mark', 'border-radius', ports)).toBe('50%')
    expect(
      style(
        ".pw-port[data-pw-port='out'] .pw-port-mark",
        'border-radius',
        ports,
      ),
    ).toBe('4px')
  })

  it('箭头独立定位在图形中心，不由文本基线定位', () => {
    const selector = '.pw-port-mark svg'
    expect(style(selector, 'position', ports)).toBe('absolute')
    expect(style(selector, 'left', ports)).toBe('50%')
    expect(style(selector, 'top', ports)).toBe('50%')
    expect(style(selector, 'transform', ports)).toBe('translate(-50%, -50%)')
  })
})
