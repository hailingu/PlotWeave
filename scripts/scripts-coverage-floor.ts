/** scripts 生产 TS 的独立行覆盖率下限（issue #726）：仿 native-canvas-coverage
 * 的 exact-path 组模式（issue #616），但清单是显式登记而非目录发现——scripts
 * 下的生产文件多为 spawn(node) 子进程驱动，v8 进程内覆盖率不可见，不能自动
 * 设 80% 下限；in-process 可测者逐文件登记，完整性与排除分类由
 * scripts/scripts-coverage-scope.test.ts 同源守卫。 */
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

/** 登记文件 → 行覆盖率下限。native-coverage 为记录的起步下限（issue #726
 * 允许低于 80% 起步；实测 53.84%，dev 9e2d89b1），其余与产品同 80；本模块
 * 自身亦经 vite.config 被 scripts 守卫测试 in-process 执行，同样登记。 */
const registeredFloors: Readonly<Record<string, number>> = {
  'scripts/gate-scope-core.ts': 80,
  'scripts/native-canvas-coverage.ts': 80,
  'scripts/native-coverage.ts': 50,
  'scripts/scripts-coverage-floor.ts': 80,
}

/** 生成 scripts 下限组（键为仓库相对 exact-path，glob 元字符此时不存在；
 * 文件缺失时 fail-closed，杜绝悬空条目静默空转）。 */
export function scriptsCoverageLineFloors(
  repositoryRoot: string,
): Record<string, { lines: number }> {
  return Object.fromEntries(
    Object.entries(registeredFloors).flatMap(([path, lines]) => {
      if (!existsSync(resolve(repositoryRoot, path))) {
        throw new Error(`scripts 覆盖率下限登记指向不存在的文件：${path}`)
      }
      return [[path, { lines }] as const]
    }),
  )
}
