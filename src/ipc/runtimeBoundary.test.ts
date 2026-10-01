/**
 * Tauri 运行环境单一来源守卫（issue #473）：哨兵是运行环境边界的契约令牌，
 * 只有 ipc/runtime.ts 可引用；通过 TypeScript AST 检查语法，注释和测试
 * 夹具不参与扫描，防止调用点重新引入独立判定。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { buildSrcModuleGraph } from '../moduleGraph'

const srcRoot = fileURLToPath(new URL('../', import.meta.url))
const runtimePath = 'ipc/runtime.ts'
const sentinel = '__TAURI_INTERNALS__'

/** AST 契约令牌识别：覆盖 in / 下标字面量、无替换模板和属性标识符。 */
function referencesRuntimeSentinel(source: string, file: string): boolean {
  const sf = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  )
  let found = false
  const visit = (node: ts.Node): void => {
    if (
      (ts.isIdentifier(node) ||
        ts.isStringLiteral(node) ||
        ts.isNoSubstitutionTemplateLiteral(node)) &&
      node.text === sentinel
    ) {
      found = true
    }
    ts.forEachChild(node, visit)
  }
  ts.forEachChild(sf, visit)
  return found
}

describe('Tauri 运行环境单一来源（issue #473）', () => {
  it('其他维护模块不得重新引用运行环境哨兵', () => {
    const violations = [...buildSrcModuleGraph(srcRoot).keys()]
      .filter((file) => file !== runtimePath)
      .filter((file) =>
        referencesRuntimeSentinel(
          readFileSync(join(srcRoot, file), 'utf8'),
          file,
        ),
      )
    expect(violations).toEqual([])
  })

  it.each([
    "const native = '__TAURI_INTERNALS__' in window",
    'const native = `__TAURI_INTERNALS__` in window',
    'const native = window.__TAURI_INTERNALS__',
    'const native = window["__TAURI_INTERNALS__"]',
  ])('识别新判定的语法令牌：%s', (source) => {
    expect(referencesRuntimeSentinel(source, 'consumer.ts')).toBe(true)
  })

  it('普通注释不会被识别为运行环境判定', () => {
    expect(
      referencesRuntimeSentinel(
        '// __TAURI_INTERNALS__\nconst value = 1',
        'consumer.tsx',
      ),
    ).toBe(false)
  })
})
