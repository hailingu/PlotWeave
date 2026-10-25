// scripts 生产代码覆盖率契约（issue #726）：scripts/ 下每个生产 TS/MJS 文件
// 必须三选一——持有独立行覆盖率下限（in-process 可测）、登记为子进程驱动
// （v8 进程内覆盖率不可见）、或按测试设施政策（issue #311）排除——且下限
// 与子进程类文件必须有测试驱动证据：删除其全部测试会使本守卫或
// npm run test:coverage 失败。断言针对配置语义，不读取文档文字。
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import { describe, expect, it } from 'vitest'
import config from '../vite.config'

const repositoryRoot = resolve(import.meta.dirname, '..')

/** 持独立行覆盖率下限的生产文件（in-process 导入可测）。native-coverage
 * 的 50 是记录的起步下限（issue #726 允许低于 80 起步；实测 53.84%，dev
 * 9e2d89b1），其余与 nativeCanvas 同为 80；下限生成模块自身经 vite.config
 * 被测试 in-process 执行，同样登记。 */
const flooredLineFloors: Readonly<Record<string, number>> = {
  'scripts/gate-scope-core.ts': 80,
  'scripts/native-canvas-coverage.ts': 80,
  'scripts/native-coverage.ts': 50,
  'scripts/scripts-coverage-floor.ts': 80,
}

/** 子进程驱动的生产文件：测试以 spawn(node, file) 集成执行，v8 覆盖率
 * 看不到子进程，无法设进程内下限；以测试驱动证据守卫替代。 */
const subprocessDriven = [
  'scripts/check-file-size.ts',
  'scripts/check-workspace-drift.ts',
  'scripts/gate-scope.ts',
  'scripts/verify-gate-evidence.ts',
  'scripts/install-hooks.mjs',
  'scripts/pre-push-install.mjs',
  'scripts/pre-push-install-launcher.mjs',
  'scripts/pre-push-install-watchdog.mjs',
] as const

/** 仅服务测试的模块（issue #311 政策延伸到 scripts）：不计入产品覆盖率，
 * 不设下限；探测构建对（build-library-import-probe 与 fixtures 探针）经
 * test-native.sh 的 npm 调用驱动、由 test-native.test.ts 断言。 */
const testFacilities = [
  'scripts/build-library-import-probe.ts',
  'scripts/gate-routing-probe.ts',
  'scripts/git-scenario-fixture.ts',
  'scripts/native-coverage-fixture.ts',
  'scripts/pre-push-scenario-fixture.ts',
  'scripts/fixtures/library-import-probe.ts',
] as const

/** 枚举 scripts 下全部生产 .ts/.mjs（测试与声明文件除外），仓库相对路径。 */
function productionScriptFiles(
  directory: string,
  out: string[] = [],
): string[] {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) productionScriptFiles(path, out)
    else if (/\.(?:test|spec)(?:-d)?\.[cm]?tsx?$|\.d\.ts$/.test(entry.name)) {
      continue
    } else if (/\.(?:ts|tsx|mjs)$/.test(entry.name)) {
      out.push(relative(repositoryRoot, path).split(sep).join('/'))
    }
  }
  return out
}

/** 与 sonar-test-scope.test.ts 同一 glob 子集语义：** 跨目录、* 段内、
 * ? 单字符，其余字面匹配——本守卫的 exclude 断言只接受该子集模式。 */
function globToRegExp(pattern: string): RegExp {
  const source = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*\/|\*\*|\*|\?/g, (token) =>
      token === '**/'
        ? '(?:.*/)?'
        : token === '**'
          ? '.*'
          : token === '*'
            ? '[^/]*'
            : '[^/]',
    )
  return new RegExp(`^${source}$`)
}

/** 测试驱动证据：测试正文含带扩展名的文件名（spawn 路径），或含
 * './<stem>' 形式的扩展名相对导入。 */
function hasTestDriverEvidence(
  basename: string,
  testContents: string[],
): boolean {
  const stem = basename.replace(/\.[cm]?tsx?$/, '')
  return testContents.some(
    (content) => content.includes(basename) || content.includes(`/${stem}'`),
  )
}

const classified = new Set([
  ...Object.keys(flooredLineFloors),
  ...subprocessDriven,
  ...testFacilities,
])
const discovered = productionScriptFiles(resolve(repositoryRoot, 'scripts'))

// 驱动证据语料必须排除本守卫自身：登记清单含全部受检文件名，自引用会让
// 删除全部真实测试后证据判定仍通过（PR #823 评审 4367590497）。下限生成
// 模块的驱动证据由 scripts/scripts-coverage-floor.test.ts 提供。
const driverEvidenceContents = readdirSync(resolve(repositoryRoot, 'scripts'))
  .filter(
    (name) =>
      /\.test\.tsx?$/.test(name) && name !== 'scripts-coverage-scope.test.ts',
  )
  .map((name) => readFileSync(resolve(repositoryRoot, 'scripts', name), 'utf8'))

describe('scripts 生产代码覆盖率分类契约（issue #726）', () => {
  it('清单完整：磁盘上的生产文件全部已分类，登记条目无悬空', () => {
    expect(
      discovered.filter((file) => !classified.has(file)),
      'scripts 下存在未分类生产文件：须登记下限、子进程或设施分类',
    ).toEqual([])
    expect(
      [...classified].filter((file) => !discovered.includes(file)),
      '登记条目指向不存在的文件（模块删除后条目悬空，削弱守卫）',
    ).toEqual([])
  })

  it('vite 下限组与下限清单同源，聚合下限与 perFile 语义不被改动', () => {
    const thresholds = config.test?.coverage?.thresholds as
      Record<string, unknown> | undefined
    expect(thresholds?.lines).toBe(80)
    expect(thresholds?.perFile).not.toBe(true)
    const scriptsGroups = Object.fromEntries(
      Object.entries(thresholds ?? {}).filter(([key]) =>
        key.startsWith('scripts/'),
      ),
    )
    expect(scriptsGroups).toEqual(
      Object.fromEntries(
        Object.entries(flooredLineFloors).map(([path, lines]) => [
          path,
          { lines },
        ]),
      ),
    )
  })

  it('coverage include 覆盖 scripts 生产 TS，exclude 精确覆盖子进程与设施 TS', () => {
    const include = config.test?.coverage?.include ?? []
    expect(include).toContain('src/**')
    expect(include).toContain('scripts/**/*.ts')
    const exclude = config.test?.coverage?.exclude ?? []
    const excludedHere = [...subprocessDriven, ...testFacilities].filter(
      (file) => file.endsWith('.ts'),
    )
    for (const file of excludedHere) {
      expect(
        exclude.some((pattern) => globToRegExp(pattern).test(file)),
        `coverage.exclude 未覆盖已分类非下限 TS 文件：${file}`,
      ).toBe(true)
    }
    for (const file of Object.keys(flooredLineFloors)) {
      expect(
        exclude.some((pattern) => globToRegExp(pattern).test(file)),
        `coverage.exclude 不得排除持有下限的生产文件：${file}`,
      ).toBe(false)
    }
  })

  it('下限与子进程类文件均有测试驱动证据（删除其全部测试即失败）', () => {
    expect(driverEvidenceContents.length).toBeGreaterThan(0)
    for (const file of [
      ...Object.keys(flooredLineFloors),
      ...subprocessDriven,
    ]) {
      const basename = file.split('/').pop() ?? ''
      expect(
        hasTestDriverEvidence(basename, driverEvidenceContents),
        `无任何 scripts 测试引用生产文件（删除全部测试将无人察觉）：${file}`,
      ).toBe(true)
    }
  })
})
