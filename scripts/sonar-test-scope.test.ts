import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import { describe, expect, it } from 'vitest'

// 测试设施分类契约（issue #311）：sonar-project.properties 以「源码
// 排除 + 测试纳入」组合（SonarQube 官方支持的机制）把仅服务测试的
// 模块与编译期类型探针归入测试范围——仍被 Sonar 分析为测试代码，
// 不计入生产源码统计；既有测试不整体失去分析，生产源码不被误分类。
// 断言以 SonarQube 路径通配符语义展开配置，不读取文档文字。

const repositoryRoot = resolve(import.meta.dirname, '..')
const propertiesPath = resolve(repositoryRoot, 'sonar-project.properties')

/** 仅服务测试的模块与编译期探针（issue #311 核实清单，仓库相对路径）。 */
const testFacilityFiles = [
  'src/editor/ai/testGraphs.ts',
  'src/model/convertFixtures.ts',
  'src/model/typeContracts.test-d.ts',
  'src/moduleGraph.ts',
  'src/styles/cssColorContract.ts',
  'src/styles/cssValueSyntax.ts',
  'src/styles/sheetTokensEngine.ts',
] as const

/** 必须保留在生产源码范围的哨兵（含与测试文件同名的 titleWhitespace）。 */
const productionSentinels = [
  'src/App.tsx',
  'src/model/document.ts',
  'src/model/legacy.ts',
  'src/model/titleWhitespace.ts',
] as const

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

  it('七类测试设施命中测试纳入并被排除出生产源码统计（仍按测试分析）', () => {
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
