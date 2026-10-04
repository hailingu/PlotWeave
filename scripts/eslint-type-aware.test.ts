/**
 * Type-aware lint 的永久契约守卫（issue #437）。
 * 契约出处：docs/development/typescript-standard.md「Type-Aware Lint Entry」
 * （issue #357）：仅 src 生产 TS/TSX 启用 projectService，两条 Promise
 * 规则均为 error；测试、编译期探针与 src 外工具保留非 type-aware 基线。
 * 使用 ESLint 实际合并后的配置语义，不读取配置或文档的普通文本。
 */
import { resolve } from 'node:path'
import { ESLint, type Linter } from 'eslint'
import { describe, expect, it } from 'vitest'

const repositoryRoot = resolve(import.meta.dirname, '..')
const eslint = new ESLint({
  cwd: repositoryRoot,
  overrideConfigFile: resolve(repositoryRoot, 'eslint.config.js'),
})
const promiseRules = [
  '@typescript-eslint/no-floating-promises',
  '@typescript-eslint/no-misused-promises',
] as const

/** 获取 ESLint 合并后的规则等级；未配置的规则视为关闭。 */
function ruleSeverity(config: Linter.Config, rule: string) {
  const setting = config.rules?.[rule]
  return Array.isArray(setting) ? setting[0] : (setting ?? 0)
}

describe('type-aware lint 适用范围与规则契约（issue #437）', () => {
  it.each([
    'src/typeAwareLintProbe.ts',
    'src/typeAwareLintProbe.tsx',
    'src/deep/typeAwareLintProbe.ts',
    'src/deep/typeAwareLintProbe.tsx',
  ])('%s 启用类型服务与 error 级 Promise 规则', async (path) => {
    const config: Linter.Config = await eslint.calculateConfigForFile(
      resolve(repositoryRoot, path),
    )
    expect(config, `${path} 必须纳入 lint`).toBeDefined()
    const projectService = config.languageOptions?.parserOptions?.projectService
    expect(
      projectService === true ||
        (typeof projectService === 'object' && projectService !== null),
      `${path} 必须启用 projectService`,
    ).toBe(true)
    for (const rule of promiseRules) {
      expect(ruleSeverity(config, rule), `${path}: ${rule}`).toBe(2)
    }
  })

  it.each([
    'src/typeAwareLintProbe.test.ts',
    'src/typeAwareLintProbe.test.tsx',
    'src/typeAwareLintProbe.test-d.ts',
    'src/deep/typeAwareLintProbe.test.ts',
    'src/deep/typeAwareLintProbe.test.tsx',
    'src/deep/typeAwareLintProbe.test-d.ts',
    'scripts/typeAwareLintProbe.ts',
    'scripts/eslint-type-aware.test.ts',
    'vite.config.ts',
  ])('%s 保留非 type-aware 基线', async (path) => {
    const config: Linter.Config = await eslint.calculateConfigForFile(
      resolve(repositoryRoot, path),
    )
    expect(config, `${path} 仍须纳入基础 lint`).toBeDefined()
    expect(config.languageOptions?.parserOptions?.projectService).toBeFalsy()
    for (const rule of promiseRules) {
      expect(ruleSeverity(config, rule), `${path}: ${rule}`).toBe(0)
    }
  })
})
