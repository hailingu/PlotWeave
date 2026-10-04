/** 核心迁出后，覆盖率流水线仍须度量两个 workspace 并对共享源码去重。 */
import { spawnSync } from 'node:child_process'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const repositoryRoot = resolve(import.meta.dirname, '..')
const temporaryRoots: string[] = []

/** LLVM 工具是外部慢边界；替身保留命令选择、报告路径与退出语义。 */
function runCoverage(mode = 'valid') {
  const sandbox = mkdtempSync(resolve(tmpdir(), 'plotweave-rust-coverage-'))
  temporaryRoots.push(sandbox)
  const llvm = resolve(sandbox, 'llvm-cov')
  const report = resolve(sandbox, 'lcov.info')
  mkdirSync(resolve(sandbox, 'src-tauri'))
  writeFileSync(resolve(sandbox, 'src-tauri/Cargo.toml'), '')
  if (mode !== 'legacy') {
    mkdirSync(resolve(sandbox, 'crates'))
    writeFileSync(resolve(sandbox, 'crates/Cargo.toml'), '')
  }
  writeFileSync(
    llvm,
    `#!/bin/sh
while [ "$#" -gt 0 ]; do
  case "$1" in
    --output-path) output=$2; shift ;;
    --manifest-path) manifest=$2; shift ;;
  esac
  shift
done
[ -f "$manifest" ] || exit 7
if [ "$manifest" = 'crates/Cargo.toml' ]; then
  [ "$PLOTWEAVE_TEST_MODE" != 'failed' ] || exit 7
  printf '%s\\n' 'SF:crates/plotweave-core/src/store/commands.rs' 'DA:1,1' 'DA:2,0' 'end_of_record' 'SF:crates/plotweave-ffi/src/lib.rs' 'DA:1,1' 'end_of_record' > "$output"
else
  printf '%s\\n' 'SF:src-tauri/src/lib.rs' 'DA:1,1' 'end_of_record' > "$output"
  if [ "$PLOTWEAVE_TEST_MODE" != 'legacy' ]; then
    printf '%s\\n' 'SF:crates/plotweave-core/src/store/commands.rs' 'DA:1,0' 'DA:2,0' 'end_of_record' >> "$output"
  fi
fi
`,
    { mode: 0o755 },
  )
  const result = spawnSync('sh', ['scripts/rust-coverage.sh'], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      PLOTWEAVE_CARGO_LLVM_COV_BIN: llvm,
      PLOTWEAVE_GATE_REPOSITORY_ROOT: sandbox,
      PLOTWEAVE_RUST_COVERAGE_REPORT_PATH: report,
      PLOTWEAVE_TEST_MODE: mode,
    },
  })
  return { ...result, report }
}

/** 按 LCOV 的 SF/DA 契约读取命中数，而非检查脚本布局或普通文案。 */
function lineHits(report: string): Map<string, Map<number, number>> {
  const files = new Map<string, Map<number, number>>()
  let current: Map<number, number> | undefined
  for (const line of report.split('\n')) {
    if (line.startsWith('SF:')) {
      const path = line.slice(3)
      expect(files.has(path), `重复的 SF 记录：${path}`).toBe(false)
      current = new Map()
      files.set(path, current)
    } else if (line.startsWith('DA:')) {
      const [number, hits] = line.slice(3).split(',').map(Number)
      current?.set(number!, hits!)
    }
  }
  return files
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

describe('Rust 跨 workspace 覆盖率', () => {
  it('合并内核与宿主命中，共享源行只计一次且未覆盖行保留', () => {
    const result = runCoverage()
    expect(result.status, result.stderr).toBe(0)
    const files = lineHits(readFileSync(result.report, 'utf8'))
    expect(files.get('src-tauri/src/lib.rs')).toEqual(new Map([[1, 1]]))
    expect(files.get('crates/plotweave-core/src/store/commands.rs')).toEqual(
      new Map([
        [1, 1],
        [2, 0],
      ]),
    )
    expect(files.get('crates/plotweave-ffi/src/lib.rs')).toEqual(
      new Map([[1, 1]]),
    )
  })

  it('任一 workspace 执行失败阻断报告生成', () => {
    expect(runCoverage('failed').status).not.toBe(0)
  })

  it('旧提交没有 crates workspace 时仍完整度量其宿主源码', () => {
    // issue #405：当前门禁脚本也须能检查尚未提取 core 的被推历史树。
    const result = runCoverage('legacy')
    expect(result.status, result.stderr).toBe(0)
    expect(lineHits(readFileSync(result.report, 'utf8'))).toEqual(
      new Map([['src-tauri/src/lib.rs', new Map([[1, 1]])]]),
    )
  })
})
