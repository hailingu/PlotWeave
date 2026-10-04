import { dirname, resolve } from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

// 契约探针的文件集合契约（issue #316）：主构建（tsconfig.json）通过
// exclude 排除 src/**/*.test-d.ts，探针仅由严格类型检查入口
// （tsconfig.strict.json）编译。断言以 TypeScript 自身的配置解析
// 语义展开两个入口实际纳入的文件集合，不读取任何文档文字。

const repositoryRoot = resolve(import.meta.dirname, '..')
const mainConfigPath = resolve(repositoryRoot, 'tsconfig.json')
const strictConfigPath = resolve(repositoryRoot, 'tsconfig.strict.json')
const probeFile = resolve(repositoryRoot, 'src/model/typeContracts.test-d.ts')
const productionFile = resolve(repositoryRoot, 'src/model/document.ts')

/** 用 TypeScript 配置解析 API 展开一个 tsconfig 实际纳入的文件集合。 */
function parseFileSet(configPath: string): readonly string[] {
  const configFile = ts.readConfigFile(configPath, ts.sys.readFile)
  const parseErrors = configFile.error ? [configFile.error] : []
  const parsed = ts.parseJsonConfigFileContent(
    configFile.config,
    ts.sys,
    dirname(configPath),
    undefined,
    configPath,
  )
  const diagnostics = [...parseErrors, ...parsed.errors]
  if (diagnostics.length > 0) {
    const details = diagnostics
      .map((diagnostic) =>
        ts.flattenDiagnosticMessageText(diagnostic.messageText, 'en'),
      )
      .join('\n')
    throw new Error(`${configPath} 解析失败：\n${details}`)
  }
  return parsed.fileNames.map((fileName) => resolve(fileName))
}

describe('tsconfig 文件集合契约（issue #316）', () => {
  const mainFiles = parseFileSet(mainConfigPath)
  const strictFiles = parseFileSet(strictConfigPath)

  it('主构建排除 *.test-d.ts 编译期契约探针', () => {
    expect(mainFiles.some((file) => file.endsWith('.test-d.ts'))).toBe(false)
  })

  it('严格入口独占纳入契约探针', () => {
    expect(strictFiles).toContain(probeFile)
  })

  it('严格入口仍排除 *.test.ts / *.test.tsx 测试文件', () => {
    expect(strictFiles.some((file) => /\.test\.tsx?$/.test(file))).toBe(false)
  })

  it('两个入口都覆盖生产源码与 vite 配置', () => {
    for (const fileSet of [mainFiles, strictFiles]) {
      expect(fileSet).toContain(productionFile)
      expect(fileSet).toContain(resolve(repositoryRoot, 'vite.config.ts'))
    }
  })
})
