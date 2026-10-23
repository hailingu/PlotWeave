// @vitest-environment happy-dom
/** 执行真实生产打包结果，确认 profiling 开关与普通构建的 React 回调语义。 */
import { resolve } from 'node:path'
import { runInNewContext } from 'node:vm'
import { build, type Plugin } from 'vite'
import { afterEach, expect, it, vi } from 'vitest'

/** 合成入口只使用真实 renderer，覆盖 createRoot 与业务入口使用的 flushSync。 */
const PROBE = `
import { createElement, Profiler } from 'react'
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
const container = document.createElement('div')
document.body.appendChild(container)
const root = createRoot(container)
const samples = []
const onRender = (_id, phase, actual, base) => samples.push({ phase, actual, base })
for (const text of ['before', 'after']) {
  flushSync(() => root.render(createElement(Profiler, { id: 'probe', onRender },
    createElement('span', null, text))))
}
window.canvasProfileProbe = { samples, text: container.textContent }
flushSync(() => root.unmount())
container.remove()
`

/** Vite 的虚拟入口避免写入生产资源或保留验证产物。 */
function probeEntry(): Plugin {
  return {
    name: 'canvas-profile-probe',
    resolveId: (id) => (id === 'virtual:canvas-profile' ? id : null),
    load: (id) => (id === 'virtual:canvas-profile' ? PROBE : null),
  }
}

/** 运行配置生成的 IIFE；合成 DOM 不代表 WKWebView 的绘制性能。 */
async function productionProbe() {
  vi.stubEnv('NODE_ENV', 'production')
  const result = await build({
    configFile: resolve('vite.native-canvas.config.ts'),
    logLevel: 'silent',
    plugins: [probeEntry()],
    build: {
      write: false,
      rolldownOptions: { input: 'virtual:canvas-profile' },
    },
  })
  if (Array.isArray(result) || !('output' in result))
    throw new Error('预期单个原生画布生产 bundle')
  const chunk = result.output.find((output) => output.type === 'chunk')
  if (!chunk || chunk.type !== 'chunk') throw new Error('缺少执行入口')
  const target = window as unknown as Record<string, unknown>
  runInNewContext(chunk.code, {
    window,
    document,
    navigator,
    performance,
    setTimeout,
    clearTimeout,
  })
  const report = target.canvasProfileProbe as {
    text: string
    samples: { phase: string; actual: number; base: number }[]
  }
  delete target.canvasProfileProbe
  return report
}

afterEach(() => vi.unstubAllEnvs())

it.each([undefined, '0', 'true'])(
  'profiling 标志为 %s 时保持普通生产 DOM 更新且无 React 采样',
  async (flag) => {
    vi.stubEnv('PLOTWEAVE_CANVAS_PROFILE', flag)
    expect(await productionProbe()).toEqual({ text: 'after', samples: [] })
  },
)

it('显式 profiling 生产构建在挂载与更新时采集真实 React 渲染', async () => {
  vi.stubEnv('PLOTWEAVE_CANVAS_PROFILE', '1')
  const report = await productionProbe()
  expect(report.text).toBe('after')
  expect(report.samples.map(({ phase }) => phase)).toEqual(['mount', 'update'])
  for (const sample of report.samples) {
    expect(Number.isFinite(sample.actual)).toBe(true)
    expect(sample.actual).toBeGreaterThanOrEqual(0)
    expect(Number.isFinite(sample.base)).toBe(true)
  }
})
