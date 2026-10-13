/**
 * 双 Cargo workspace 共享内核依赖闭包的版本漂移护栏（issue #549 方案 3）：
 * `crates/` 与 `src-tauri/` 各自独立解析，`plotweave-core` 被两边按各自的
 * Cargo.lock 编译。本脚本以 `cargo tree --locked` 的真实解析为准，比对内核
 * 闭包（normal+build 边、宿主目标）中共享包的版本集——不解析两份锁文件，
 * 因为 Cargo.lock 的 dependencies 列表按整图 feature 统一合并，会把
 * workspace 其他成员启用的可选依赖混入内核的块。`--locked` 同时保证检查
 * 永不改写锁文件：锁与 manifest 失同步时 cargo 直接失败并透传。
 */
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'

/** 被两个 workspace 独立解析编译的共享内核；漂移以它的闭包为口径。 */
const sharedRootPackage = 'plotweave-core'

/** 参与 IPC 的两个 workspace 名（目录名），顺序决定诊断中的报告顺序。 */
const workspaces = ['crates', 'src-tauri'] as const

/** 闭包视图：包名 → 该名字在闭包中解析出的版本集合。 */
type PackageVersions = Map<string, Set<string>>

/** 采集一侧 workspace 中共享内核的依赖闭包（cargo tree --prefix none 文本）。 */
function treeOutput(workspace: string): string {
  return execFileSync(
    'cargo',
    [
      'tree',
      '--locked',
      '-p',
      sharedRootPackage,
      '--edges',
      'normal,build',
      '--prefix',
      'none',
    ],
    { cwd: resolve(import.meta.dirname, '..', workspace), encoding: 'utf8' },
  )
}

/** `--prefix none` 行形状为 `name vX.Y.Z [本地路径]`；重复行按集合吸收。 */
function parseTreePackages(text: string): PackageVersions {
  const packages: PackageVersions = new Map()
  for (const line of text.split('\n')) {
    const match = /^(\S+) v(\S+)/.exec(line)
    if (!match) continue
    const [, name, version] = match
    const versions = packages.get(name) ?? new Set<string>()
    versions.add(version)
    packages.set(name, versions)
  }
  return packages
}

function sameVersions(left: Set<string>, right: Set<string>): boolean {
  return (
    left.size === right.size && [...left].every((version) => right.has(version))
  )
}

/**
 * 采集一个 workspace 中共享内核的依赖闭包并校验可解释性：cargo 失败
 * （不可用、锁失同步）或闭包解析不出根包（输出格式变更、包装器）都
 * 留结构化诊断、置非零退出码并返回 null——绝不产出半截比较结论。
 */
function collectClosure(workspace: string): PackageVersions | null {
  let closure: PackageVersions
  try {
    closure = parseTreePackages(treeOutput(workspace))
  } catch (error) {
    const captured = error as { stderr?: unknown }
    const stderr = typeof captured.stderr === 'string' ? captured.stderr : ''
    const message = error instanceof Error ? error.message : String(error)
    console.error(
      JSON.stringify({
        code: 'DRIFT_CARGO_FAILED',
        workspace,
        message,
        stderr,
      }),
    )
    process.exitCode = 1
    return null
  }
  // 闭包解析不出根包说明本次没有可比对的真实解析——两个空闭包会得到
  // compared: 0 的假通过，必须显式失败而非静默放行（评审 5506545630）。
  if (!closure.has(sharedRootPackage)) {
    console.error(
      JSON.stringify({
        code: 'DRIFT_CLOSURE_INVALID',
        workspace,
        root: sharedRootPackage,
        parsedCount: closure.size,
      }),
    )
    process.exitCode = 1
    return null
  }
  return closure
}

/**
 * 输出两个闭包的漂移诊断并返回汇总：共享包版本集不一致即逐包列出两侧
 * 版本；仅一侧出现的包是双 workspace feature 统一的结构性差异（如
 * src-tauri 侧其他依赖为共享包启用的可选特性），警告留痕不计为漂移。
 */
function reportClosureDrift(
  first: string,
  second: string,
  firstClosure: PackageVersions,
  secondClosure: PackageVersions,
): { compared: number; driftCount: number; sideOnlyCount: number } {
  const sideOnly: { side: string; package: string; versions: string[] }[] = []
  let driftCount = 0
  for (const [name, versions] of firstClosure) {
    const other = secondClosure.get(name)
    if (!other) {
      sideOnly.push({
        side: first,
        package: name,
        versions: [...versions].sort(),
      })
      continue
    }
    if (sameVersions(versions, other)) continue
    console.log(
      JSON.stringify({
        code: 'DRIFT_VERSION_MISMATCH',
        package: name,
        [first]: [...versions].sort(),
        [second]: [...other].sort(),
      }),
    )
    driftCount += 1
  }
  for (const [name, versions] of secondClosure) {
    if (firstClosure.has(name)) continue
    sideOnly.push({
      side: second,
      package: name,
      versions: [...versions].sort(),
    })
  }
  for (const entry of sideOnly) {
    console.log(JSON.stringify({ code: 'DRIFT_SIDE_ONLY', ...entry }))
  }
  const compared = [...firstClosure.keys()].filter((name) =>
    secondClosure.has(name),
  ).length
  return { compared, driftCount, sideOnlyCount: sideOnly.length }
}

/** 主流程：采集两侧闭包 → 输出漂移诊断 → 汇总退出状态。 */
function main(): void {
  const closures = new Map<string, PackageVersions>()
  for (const workspace of workspaces) {
    const closure = collectClosure(workspace)
    if (!closure) return
    closures.set(workspace, closure)
  }
  const [first, second] = workspaces
  const firstClosure = closures.get(first)
  const secondClosure = closures.get(second)
  if (!firstClosure || !secondClosure) return
  const summary = reportClosureDrift(first, second, firstClosure, secondClosure)
  console.log(
    JSON.stringify({
      code: 'DRIFT_CHECK_COMPLETE',
      ...summary,
      passed: summary.driftCount === 0,
    }),
  )
  process.exitCode = summary.driftCount === 0 ? 0 : 1
}

try {
  main()
} catch (error) {
  console.error(
    JSON.stringify({
      code: 'DRIFT_INPUT_ERROR',
      message: error instanceof Error ? error.message : String(error),
    }),
  )
  process.exitCode = 1
}
