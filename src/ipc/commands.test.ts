/**
 * IPC 命令名契约守卫（issue #394）：Rust `generate_handler!` 注册的命令与
 * 前端 `IPC_COMMANDS`（src/ipc/commands.ts，命令名单一事实源）的四条
 * 双向断言——
 * 1. 常量集与注册集一致：不漏（注册命令必有常量，前端才可引用）、
 *    不多（常量必已注册且值不重复）；
 * 2. 类型化入口排他（issue #394 评审 5339899090）：'@tauri-apps/api/core'
 *    的 import 说明符（静态或动态）只允许出现在 src/ipc/invoke.ts——
 *    ipcInvoke 以 IpcCommandName 收窄 cmd 参数，字符串字面量、别名导入
 *    与变量中转都在编译期拒绝；其余维护模块出现该说明符即守卫失败，
 *    而别名/解构/Promise.all/.then 等一切绑定形态都必写该说明符，
 *    无从绕过；
 * 3. invoke 系调用点（标识符含 invoke 者，如 ipcInvoke / tauriInvoke）的
 *    首参不得是字符串字面量——命令名字面量只允许出现在常量表与
 *    generate_handler! 两侧（纵深防线，类型收窄之外的兜底）；
 * 4. 每个常量都有前端消费者（IPC_COMMANDS.<key> 被至少一个维护模块
 *    引用）——注册而无人消费的命令同样视为契约漂移。
 * 扫描口径与 moduleGraph 一致：src 下非测试 .ts/.tsx，AST 解析（注释与
 * 事件名 listen/emit 不误报）；lib.rs 解析剥行注释，令牌形态异常即抛错
 * （fail-closed，与 moduleGraph 无法解析相对导入即抛错同口径）。
 */
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { resolveEdgeTarget } from '../moduleGraph'
import { IPC_COMMANDS } from './commands'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../..')
const registeredSourcePath = join(repoRoot, 'src-tauri/src/lib.rs')
const srcRoot = join(repoRoot, 'src')
const commandsModulePath = join(srcRoot, 'ipc/commands.ts')
const invokeModulePath = join(srcRoot, 'ipc/invoke.ts')
const coreSpecifier = '@tauri-apps/api/core'

/** 维护模块 = src 下非测试 .ts/.tsx（与 moduleGraph 口径一致）。 */
const isMaintainedModule = (p: string): boolean =>
  /\.tsx?$/.test(p) && !/\.test\.tsx?$/.test(p) && !p.endsWith('.d.ts')

/** 深度优先枚举 src 下的维护模块（绝对路径）。 */
function listMaintainedModules(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...listMaintainedModules(p))
    else if (isMaintainedModule(p)) out.push(p)
  }
  return out
}

/** generate_handler! 注册清单：剥行注释后取宏实参内的逗号分隔令牌，
 * 令牌须为 `a::b::c` 形态的 Rust 路径，命令名取最后一段；无法识别的
 * 令牌抛错（fail-closed——静默跳过会让注册集少计、守卫形同虚设）。 */
function registeredIpcCommandNames(): string[] {
  const source = readFileSync(registeredSourcePath, 'utf8')
  const withoutComments = source.replace(/\/\/[^\n]*/g, '')
  const macroAt = withoutComments.indexOf('generate_handler!')
  if (macroAt < 0) {
    throw new Error('src-tauri/src/lib.rs 中未找到 generate_handler!')
  }
  const listStart = withoutComments.indexOf('[', macroAt)
  const listEnd = listStart >= 0 ? withoutComments.indexOf(']', listStart) : -1
  if (listStart < 0 || listEnd < 0) {
    throw new Error('generate_handler! 注册清单不完整（缺少成对中括号）')
  }
  const names: string[] = []
  for (const token of withoutComments
    .slice(listStart + 1, listEnd)
    .split(',')
    .map((raw) => raw.trim())
    .filter((raw) => raw !== '')) {
    if (!/^[a-z_][a-z0-9_]*(::[a-z_][a-z0-9_]*)*$/.test(token)) {
      throw new Error(`generate_handler! 清单中出现无法识别的令牌：${token}`)
    }
    names.push(token.split('::').pop() ?? token)
  }
  return names
}

/** 调用点中被视为 IPC 入口的标识符：callee 为标识符或属性访问名，且
 * 名字含 invoke（覆盖 invoke / tauriInvoke 及未来的 *Invoke 包装）。 */
function invokeCalleeName(expression: ts.Expression): string | null {
  if (ts.isIdentifier(expression)) return expression.text
  if (
    ts.isPropertyAccessExpression(expression) &&
    ts.isIdentifier(expression.name)
  )
    return expression.name.text
  return null
}

/** 单文件中绑定到 IPC_COMMANDS 的本地名（具名导入，允许 as 别名）；
 * 命名空间导入不采集——两级访问（ns.IPC_COMMANDS.key）不属既定约定，
 * 守卫按「无消费者」失败并指向本约定。 */
function commandBindingNamesOf(sf: ts.SourceFile, file: string): Set<string> {
  const names = new Set<string>()
  const visit = (node: ts.Node): void => {
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      const resolved = resolveEdgeTarget(file, node.moduleSpecifier.text)
      if (resolved.kind === 'module' && resolved.path === commandsModulePath) {
        const named = node.importClause?.namedBindings
        if (named !== undefined && ts.isNamedImports(named)) {
          for (const element of named.elements) {
            if (
              element.name.text === 'IPC_COMMANDS' ||
              element.propertyName?.text === 'IPC_COMMANDS'
            ) {
              names.add(element.name.text)
            }
          }
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  ts.forEachChild(sf, visit)
  return names
}

/** 前端维护模块的 IPC 使用面：字面量调用点（应为空）、core 说明符越界
 * 引用（应为空）与被引用的命令键。 */
function scanFrontendIpcUsage(): {
  literalCalls: string[]
  coreImportsOutsideWrapper: string[]
  accessedCommandKeys: Set<string>
} {
  const literalCalls: string[] = []
  const coreImportsOutsideWrapper: string[] = []
  const accessedCommandKeys = new Set<string>()
  for (const file of listMaintainedModules(srcRoot)) {
    const kind = file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
    const sf = ts.createSourceFile(
      file,
      readFileSync(file, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
      kind,
    )
    // 常量表自身不构成消费：定义处不扫描键访问
    const bindingNames =
      file === commandsModulePath
        ? new Set<string>()
        : commandBindingNamesOf(sf, file)
    const recordCoreImport = (specifier: string): void => {
      // 类型化入口模块是唯一豁免：它持有全仓唯一的原始 invoke 绑定
      if (file !== invokeModulePath) {
        coreImportsOutsideWrapper.push(
          `${relative(srcRoot, file)} → ${specifier}`,
        )
      }
    }
    const visit = (node: ts.Node): void => {
      if (
        ts.isImportDeclaration(node) &&
        ts.isStringLiteral(node.moduleSpecifier) &&
        node.moduleSpecifier.text === coreSpecifier
      ) {
        recordCoreImport(node.moduleSpecifier.text)
      }
      if (ts.isCallExpression(node)) {
        const spec =
          node.expression.kind === ts.SyntaxKind.ImportKeyword
            ? node.arguments[0]
            : undefined
        if (
          spec !== undefined &&
          ts.isStringLiteral(spec) &&
          spec.text === coreSpecifier
        ) {
          recordCoreImport(spec.text)
        }
        const callee = invokeCalleeName(node.expression)
        const first = node.arguments[0]
        if (
          callee !== null &&
          /invoke/i.test(callee) &&
          first !== undefined &&
          (ts.isStringLiteral(first) ||
            ts.isNoSubstitutionTemplateLiteral(first))
        ) {
          literalCalls.push(
            `${relative(srcRoot, file)} → ${callee}('${first.text}')`,
          )
        }
      }
      if (
        ts.isPropertyAccessExpression(node) &&
        ts.isIdentifier(node.expression) &&
        bindingNames.has(node.expression.text)
      ) {
        accessedCommandKeys.add(node.name.text)
      }
      ts.forEachChild(node, visit)
    }
    ts.forEachChild(sf, visit)
  }
  return { literalCalls, coreImportsOutsideWrapper, accessedCommandKeys }
}

describe('IPC 命令名契约（issue #394）', () => {
  it('常量集与 generate_handler! 注册集双向一致（不漏不多不重复）', () => {
    const registered = registeredIpcCommandNames()
    // 加宽到 string[]：includes 以普通字符串比对注册清单，不借字面量联合收窄
    const values: string[] = Object.values(IPC_COMMANDS)
    const missing = registered.filter((name) => !values.includes(name))
    const extra = values.filter((name) => !registered.includes(name))
    expect(missing).toEqual([])
    expect(extra).toEqual([])
    expect(new Set(values).size).toBe(values.length)
  })

  it('原始 invoke 入口排他：core 说明符只允许出现在 src/ipc/invoke.ts', () => {
    expect(scanFrontendIpcUsage().coreImportsOutsideWrapper).toEqual([])
  })

  it('前端 invoke 系调用点的首参不得是字符串字面量', () => {
    expect(scanFrontendIpcUsage().literalCalls).toEqual([])
  })

  it('每个命令常量都有前端消费者（IPC_COMMANDS.<key> 被引用）', () => {
    const accessed = scanFrontendIpcUsage().accessedCommandKeys
    const unconsumed = Object.keys(IPC_COMMANDS).filter(
      (key) => !accessed.has(key),
    )
    expect(unconsumed).toEqual([])
  })
})
