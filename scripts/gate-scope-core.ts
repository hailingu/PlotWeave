/**
 * 推送门禁的变更范围分类（owner 指示 2026-10-18）：把一次推送涉及的
 * 路径归为 docs / frontend / rust / native / full，供 pre-push 与
 * sonar-quality-gate.sh 选择最小充分门禁。纯函数，不读文件系统；CLI 在
 * gate-scope.ts 中用 `git diff --name-only` 提供路径。
 *
 * 规则：
 * - 全部是文档 → docs；文档不改变代码，可跳过代码回归/覆盖率/Sonar。
 * - 文档之外只落在一个实现域 → 该域；只跑该域的全量回归与覆盖率，另一
 *   栈复用最近 LCOV 供 Sonar。
 * - 跨域、工具/门禁/未知路径 → full；这些变更可能影响所有实现或门禁
 *   自身，不能安全地缩小范围。
 * - 空路径（无差异、根提交或无法分类）→ full，绝不因“没有变化”跳过。
 */
export type GateScope = 'docs' | 'frontend' | 'rust' | 'native' | 'full'

/** 文档路径：docs/ 下的文件、根 Markdown、许可证；不把代码注释/文档
 * 资产误归为文档。 */
export function isDocumentationPath(path: string): boolean {
  const normalized = normalizePath(path)
  if (normalized === 'LICENSE' || normalized === 'LICENSE.md') return true
  if (normalized.startsWith('docs/')) return true
  return !normalized.includes('/') && normalized.endsWith('.md')
}

/** 实现域：frontend = React/TS 入口与清单；rust = 两个 Cargo workspace；
 * native = Swift/Xcode。其余（scripts/.githooks/.github/根配置）为 tooling。 */
function stackOf(path: string): 'frontend' | 'rust' | 'native' | 'tooling' {
  const normalized = normalizePath(path)
  if (
    normalized.startsWith('src/') ||
    normalized.startsWith('public/') ||
    normalized === 'tsconfig.json' ||
    normalized === 'tsconfig.strict.json' ||
    normalized === 'vite.config.ts' ||
    normalized === 'index.html'
  ) {
    return 'frontend'
  }
  if (
    normalized.startsWith('src-tauri/') ||
    normalized.startsWith('crates/') ||
    normalized === 'rust-toolchain.toml'
  ) {
    return 'rust'
  }
  if (normalized.startsWith('native/')) return 'native'
  return 'tooling'
}

/** 统一路径分隔与前缀；git 输出使用 `/`，这里只做防御性归一。 */
function normalizePath(path: string): string {
  return path.replaceAll('\\', '/').replace(/^\.\//, '')
}

/** 分类一组变更路径；空集合与无法安全归类的集合都回退到 full。 */
export function classifyChangedPaths(paths: readonly string[]): GateScope {
  if (paths.length === 0) return 'full'
  const stacks = new Set<'frontend' | 'rust' | 'native'>()
  for (const path of paths) {
    if (isDocumentationPath(path)) continue
    const stack = stackOf(path)
    if (stack === 'tooling') return 'full'
    stacks.add(stack)
    if (stacks.size > 1) return 'full'
  }
  return stacks.size === 0 ? 'docs' : [...stacks][0]!
}
