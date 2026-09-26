import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ScriptKind } from 'typescript'
import {
  buildSrcModuleGraph,
  relativeEdgesOfSource,
  resolveEdgeTarget,
} from '../src/moduleGraph'
import config from '../vite.config'

// 测试设施分类契约（issue #311，issue #343 补录 sheetRuleQuery 并扩展
// 一致性守卫）：sonar-project.properties 以「源码排除 + 测试纳入」组合
// （SonarQube 官方支持的机制）把仅服务测试的模块与编译期类型探针归入
// 测试范围——仍被 Sonar 分析为测试代码，不计入生产源码统计；既有测试
// 不整体失去分析，生产源码不被误分类。issue #343 起另以导入者侧守卫
// 防拆分遗漏——运行时导入者全为测试设施的未分类模块即失败（复用
// moduleGraph 的 AST 边解析），并与 vite coverage.exclude 同源核验。
// 断言以 SonarQube 路径通配符语义展开配置，不读取文档文字。

const repositoryRoot = resolve(import.meta.dirname, '..')
const propertiesPath = resolve(repositoryRoot, 'sonar-project.properties')

/** 仅服务测试的模块与编译期探针（issue #311 核实清单，issue #343 补录
 * sheetRuleQuery，仓库相对路径）。 */
const testFacilityFiles = [
  'src/editor/ai/testGraphs.ts',
  'src/model/convertFixtures.ts',
  'src/model/typeContracts.test-d.ts',
  'src/moduleGraph.ts',
  'src/styles/cssColorContract.ts',
  'src/styles/cssValueSyntax.ts',
  'src/styles/sheetRuleQuery.ts',
  'src/styles/sheetTokensEngine.ts',
] as const

/** 必须保留在生产源码范围的哨兵（含与测试文件同名的 titleWhitespace）。 */
const productionSentinels = [
  'src/App.tsx',
  'src/model/document.ts',
  'src/model/legacy.ts',
  'src/model/titleWhitespace.ts',
] as const

/** 产品入口哨兵：入口模块被 index.html 直接加载、在 src 内零导入者，
 * 不因「仅被测试导入」误判为测试设施（issue #343 守卫的构成性豁免）。 */
const productionEntryFiles = ['src/main.tsx'] as const

/** 解析 .properties 格式：# 注释与空行忽略，键值以首个 = 分割。 */
function readSonarProperties(path: string): Map<string, string> {
  const entries = new Map<string, string>()
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith('#')) {
      continue
    }
    const separator = trimmed.indexOf('=')
    if (separator > 0) {
      entries.set(trimmed.slice(0, separator), trimmed.slice(separator + 1))
    }
  }
  return entries
}

/** 逗号分隔的 SonarQube 路径模式列表展开为模式数组。 */
function splitPatterns(
  properties: Map<string, string>,
  key: string,
): readonly string[] {
  return (properties.get(key) ?? '')
    .split(',')
    .map((pattern) => pattern.trim())
    .filter((pattern) => pattern !== '')
}

/** SonarQube 路径通配符语义：** 跨目录（含零目录），* 段内任意，
 * ? 单字符；其余字符按字面匹配。 */
function sonarPatternToRegExp(pattern: string): RegExp {
  const source = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*\/|\*\*|\*|\?/g, (token) => {
      if (token === '**/') {
        return '(?:.*/)?'
      }
      if (token === '**') {
        return '.*'
      }
      if (token === '*') {
        return '[^/]*'
      }
      return '[^/]'
    })
  return new RegExp(`^${source}$`)
}

/** 枚举 src 下全部 *.test.ts(x)，返回仓库相对的正斜杠路径。 */
function listTestFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      listTestFiles(path, out)
    } else if (/\.test\.tsx?$/.test(entry.name)) {
      out.push(relative(repositoryRoot, path).split(sep).join('/'))
    }
  }
  return out
}

describe('Sonar 测试设施分类契约（issue #311）', () => {
  const properties = readSonarProperties(propertiesPath)
  const testInclusions = splitPatterns(properties, 'sonar.test.inclusions')
  const exclusions = splitPatterns(properties, 'sonar.exclusions')
  const matchesAny = (patterns: readonly string[], path: string): boolean =>
    patterns.some((pattern) => sonarPatternToRegExp(pattern).test(path))

  it('全部测试设施命中测试纳入并被排除出生产源码统计（仍按测试分析）', () => {
    for (const file of testFacilityFiles) {
      expect(
        matchesAny(testInclusions, file),
        `sonar.test.inclusions 应归类为测试：${file}`,
      ).toBe(true)
      expect(
        matchesAny(exclusions, file),
        `sonar.exclusions 应移出生产源码统计：${file}`,
      ).toBe(true)
    }
  })

  it('既有 *.test.ts(x) 全部仍命中测试纳入，测试不整体失去分析', () => {
    const testFiles = listTestFiles(resolve(repositoryRoot, 'src'))
    expect(testFiles.length).toBeGreaterThan(50)
    for (const file of testFiles) {
      expect(
        matchesAny(testInclusions, file),
        `既有测试被移出测试纳入：${file}`,
      ).toBe(true)
    }
  })

  it('生产源码哨兵不被误分类为测试', () => {
    for (const file of productionSentinels) {
      expect(
        matchesAny(testInclusions, file),
        `生产文件不应进入测试范围：${file}`,
      ).toBe(false)
    }
  })
})

describe('测试设施导入者侧分类守卫（issue #343，拆分防遗漏）', () => {
  it('分类双向判定：未分类仅测试导入即失败，设施现产品导入者也失败', () => {
    const srcRoot = resolve(repositoryRoot, 'src')
    const graph = buildSrcModuleGraph(srcRoot)
    const facilityKeys = new Set(
      testFacilityFiles.map((file) => file.slice('src/'.length)),
    )
    const entryKeys = new Set(
      productionEntryFiles.map((file) => file.slice('src/'.length)),
    )
    const importers = new Map<string, string[]>()
    const record = (target: string, source: string): void => {
      if (!graph.has(target)) return
      const list = importers.get(target) ?? []
      list.push(source)
      importers.set(target, list)
    }
    // 类型边与值边同采（issue #343 评审）：生产模块仅经 import type 使用
    // 的模块仍是产品类型载体，不得因测试侧值导入被误判为测试设施；测试
    // 侧类型导入同样作为测试侧证据纳入。仅动态导入无法静态定位，不采集。
    for (const [source, edges] of graph) {
      for (const edge of edges) {
        if (edge.dynamic === true) continue
        record(edge.target, source)
      }
    }
    // 反向图覆盖仓库内全部 vitest 测试目录（issue #343 评审）：src 之外
    // 的 scripts/*.test.ts(x) 也会导入 src 辅助模块（如本守卫导入
    // moduleGraph），只扫 src 会漏掉仅被 scripts 测试导入的目标。
    const testRoots = ['src', 'scripts']
    for (const root of testRoots) {
      for (const rel of listTestFiles(resolve(repositoryRoot, root))) {
        const testFile = resolve(repositoryRoot, rel)
        // .tsx 按其语法解析（issue #343 评审）：以默认 TS 解析 JSX 之后的
        // 导入依赖错误恢复，漏采会让仅被该类边引用的模块逃过守卫。
        const kind = testFile.endsWith('.tsx') ? ScriptKind.TSX : ScriptKind.TS
        for (const edge of relativeEdgesOfSource(
          readFileSync(testFile, 'utf8'),
          kind,
        )) {
          if (edge.dynamic === true) continue
          const resolved = resolveEdgeTarget(testFile, edge.spec)
          if (resolved.kind === 'asset') continue
          if (resolved.kind === 'unresolved') {
            throw new Error(
              `测试文件存在无法解析的相对导入：${rel} → ${edge.spec}`,
            )
          }
          record(relative(srcRoot, resolved.path).split(sep).join('/'), rel)
        }
      }
    }
    for (const [target, sources] of importers) {
      const productSources = sources.filter(
        (source) => !facilityKeys.has(source) && !/\.test\.tsx?$/.test(source),
      )
      if (facilityKeys.has(target)) {
        // 已分类设施不得出现产品导入者（issue #343 评审）：应用侧一旦
        // 导入设施，应将其移出清单回归产品统计，而非继续靠排除配置
        // 跳过统计。
        expect(
          productSources,
          `已分类测试设施出现产品侧导入者，应移出设施清单：${target} ← ${productSources.join(', ')}`,
        ).toEqual([])
        continue
      }
      if (entryKeys.has(target)) continue
      expect(
        productSources.length,
        `模块 ${target} 仅被测试设施/测试文件导入却未按测试设施分类：${sources.join(', ')}`,
      ).toBeGreaterThan(0)
    }
  })
})

describe('vite 覆盖率排除与设施清单同源（issue #343）', () => {
  it('全部测试设施被 coverage.exclude 覆盖', () => {
    const exclude = config.test?.coverage?.exclude ?? []
    for (const file of testFacilityFiles) {
      expect(
        exclude.some((pattern) => sonarPatternToRegExp(pattern).test(file)),
        `vite coverage.exclude 未覆盖测试设施：${file}`,
      ).toBe(true)
    }
  })

  it('coverage.exclude 反向核验：不命中清单外的维护模块', () => {
    const exclude = config.test?.coverage?.exclude ?? []
    const graph = buildSrcModuleGraph(resolve(repositoryRoot, 'src'))
    const facilityKeys = new Set(
      testFacilityFiles.map((file) => file.slice('src/'.length)),
    )
    const offenders: string[] = []
    for (const key of graph.keys()) {
      const repoPath = `src/${key}`
      if (
        !facilityKeys.has(key) &&
        exclude.some((pattern) => sonarPatternToRegExp(pattern).test(repoPath))
      ) {
        offenders.push(repoPath)
      }
    }
    expect(
      offenders,
      'coverage.exclude 命中测试设施清单之外的维护模块，产品覆盖率将被静默丢弃',
    ).toEqual([])
  })
})
