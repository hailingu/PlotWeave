// @vitest-environment happy-dom
/** 用 CSSOM 求实际级联验证特效对照，不断言源码布局或文字。 */
import { afterEach, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

afterEach(() => {
  document.body.replaceChildren()
  document.head.replaceChildren()
})

/** 两个画布拥有同样特效；只切换一个根来验证作用域与恢复。 */
function mountStyles(reverse: boolean) {
  const controlsCss = readFileSync(
    resolve('src/editor/canvasControls.css'),
    'utf8',
  )
  const nodesCss = readFileSync(resolve('src/editor/nodes/nodes.css'), 'utf8')
  const performanceCss = readFileSync(
    resolve('src/editor/canvasPerformance.css'),
    'utf8',
  )
  const style = document.createElement('style')
  const baseline = `${controlsCss}\n${nodesCss}`
  style.textContent = reverse
    ? `${performanceCss}\n${baseline}`
    : `${baseline}\n${performanceCss}`
  document.head.append(style)
  document.body.innerHTML = Array.from(
    { length: 2 },
    () => `
    <div class="canvas-root is-swift" data-canvas-effects="standard">
      <div class="pw-card" style="--shadow-node: 0 2px 8px black; width: 100px; height: 80px"></div>
      <div class="react-flow__controls"></div>
    </div>`,
  ).join('')
  return [...document.querySelectorAll<HTMLElement>('.canvas-root')]
}

/** 读取浏览器计算属性；几何与命中属性不是特效对照的变更范围。 */
function appearance(root: HTMLElement) {
  const card = getComputedStyle(root.querySelector('.pw-card')!)
  const controls = getComputedStyle(
    root.querySelector('.react-flow__controls')!,
  )
  return {
    shadow: card.boxShadow,
    transition: card.transitionProperty,
    blur: controls.getPropertyValue('backdrop-filter'),
    geometry: [card.width, card.height, card.display, card.pointerEvents],
  }
}

it.each([false, true])(
  '特效级联顺序反转=%s 时仍隔离两个画布并可恢复',
  (reverse) => {
    const [root, other] = mountStyles(reverse) as [HTMLElement, HTMLElement]
    const initial = appearance(root)
    expect(initial.shadow).not.toBe('none')
    expect(initial.blur).toBe('blur(20px)')
    root.dataset.canvasEffects = 'reduced-effects'
    const reduced = appearance(root)
    expect(reduced.shadow).toBe('none')
    expect(reduced.transition).toBe('none')
    expect(reduced.blur).toBe('none')
    expect(reduced.geometry).toEqual(initial.geometry)
    expect(appearance(other)).toEqual(initial)
    root.dataset.canvasEffects = 'standard'
    expect(appearance(root)).toEqual(initial)
  },
)
