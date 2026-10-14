import { vi } from 'vitest'

/**
 * panels 组件测试的共享 DOM 桩（issue #539）：happy-dom 未实现的
 * IntersectionObserver 与 Element.prototype.scrollTo 原在各测试文件
 * 逐字复制，现收敛于此。按 issue #311 的归类决定与测试同目录放置并
 * 登记为测试设施（sonar-project.properties 的「源码排除 + 测试纳入」
 * 组合、vite 覆盖率 exclude，契约由 scripts/sonar-test-scope.test.ts
 * 守卫）：不进生产 bundle，仍被 Sonar 按测试代码分析；导入者只能是
 * 测试文件或测试设施。
 */

/** happy-dom 未实现 scrollTo：时间线滚动跟随副作用在此环境下打桩。 */
export function stubElementScrollTo(): void {
  Element.prototype.scrollTo = vi.fn()
}

/**
 * happy-dom 无 IntersectionObserver：构造 observe/unobserve/disconnect
 * 骨架桩。fireOnObserve=true 时 observe 即触发相交回调（缩略图懒加载
 * 用例依赖立即触发）；false 为静默桩（仅需满足构造调用的用例）。
 */
export function stubIntersectionObserver(fireOnObserve = false): void {
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      constructor(private cb: IntersectionObserverCallback) {}
      observe(el: Element) {
        if (fireOnObserve)
          this.cb(
            [{ isIntersecting: true, target: el } as IntersectionObserverEntry],
            this as never,
          )
      }
      unobserve() {}
      disconnect() {}
    },
  )
}
