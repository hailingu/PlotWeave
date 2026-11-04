/** scripts 覆盖率下限登记的行为单元（issue #726）：组形态契约与 fail-closed。
 * 精确登记集合由 scripts-coverage-scope.test.ts 对照 vite 配置同源守卫，
 * 此处不重复清单。 */
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { scriptsCoverageLineFloors } from './scripts-coverage-floor'

const repositoryRoot = resolve(import.meta.dirname, '..')

describe('scripts 覆盖率下限登记（issue #726）', () => {
  it('产出 scripts 下 exact-path 行下限组，形态为 {lines: ≥50}', () => {
    const floors = scriptsCoverageLineFloors(repositoryRoot)
    expect(Object.keys(floors).length).toBeGreaterThan(0)
    for (const [path, threshold] of Object.entries(floors)) {
      expect(path.startsWith('scripts/') && path.endsWith('.ts'), path).toBe(
        true,
      )
      expect(threshold, path).toEqual({ lines: expect.any(Number) })
      expect(
        (threshold as { lines: number }).lines,
        path,
      ).toBeGreaterThanOrEqual(50)
    }
  })

  it('登记路径缺失时 fail-closed 抛错，不产出部分/空下限组', () => {
    // 临时空根下任何登记路径都不存在，不得静默返回空结果。
    expect(() =>
      scriptsCoverageLineFloors(join(repositoryRoot, 'scripts', 'fixtures')),
    ).toThrow('不存在的文件')
  })
})
