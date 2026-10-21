/** 生产失败诊断只能经统一层输出，避免新增调用点重新退回裸 console。 */
import { globSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import ts from 'typescript'

it('生产调用点没有绕过统一层直接调用 console.warn/error', () => {
  const root = fileURLToPath(new URL('.', import.meta.url))
  const violations: string[] = []
  for (const name of globSync('**/*.{ts,tsx}', { cwd: root })) {
    if (name.includes('.test.') || name === 'diagnostics.ts') continue
    const source = ts.createSourceFile(
      name,
      readFileSync(new URL(name, import.meta.url), 'utf8'),
      ts.ScriptTarget.Latest,
      true,
    )
    const visit = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        ts.isIdentifier(node.expression.expression) &&
        node.expression.expression.text === 'console' &&
        ['warn', 'error'].includes(node.expression.name.text)
      ) {
        violations.push(
          `${name}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}`,
        )
      }
      ts.forEachChild(node, visit)
    }
    visit(source)
  }
  expect(violations).toEqual([])
})
