/** 核心迁出后，覆盖率流水线仍须度量两个 workspace 并对共享源码去重。 */
import { spawnSync } from 'node:child_process'
import {
  existsSync,
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
function runCoverage(mode = 'valid', budget?: number | string) {
  const sandbox = mkdtempSync(resolve(tmpdir(), 'plotweave-rust-coverage-'))
  temporaryRoots.push(sandbox)
  const llvm = resolve(sandbox, 'llvm-cov')
  const report = resolve(sandbox, 'lcov.info')
  const llvmLog = resolve(sandbox, 'llvm-invocations.log')
  mkdirSync(resolve(sandbox, 'src-tauri'))
  writeFileSync(resolve(sandbox, 'src-tauri/Cargo.toml'), '')
  if (mode !== 'legacy') {
    mkdirSync(resolve(sandbox, 'crates'))
    writeFileSync(resolve(sandbox, 'crates/Cargo.toml'), '')
  }
  writeFileSync(
    llvm,
    `#!/bin/sh
printf 'cargo-llvm-cov %s\\n' "$*" >> "${llvmLog}"
[ -n "\${RUST_TEST_THREADS:-}" ] && printf 'rust-test-threads %s\\n' "$RUST_TEST_THREADS" >> "${llvmLog}"
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
      ...(budget !== undefined
        ? { PLOTWEAVE_GATE_CPU_BUDGET: String(budget) }
        : {}),
    },
  })
  return {
    ...result,
    invocations: existsSync(llvmLog) ? readFileSync(llvmLog, 'utf8') : '',
    report,
  }
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

describe('Rust 覆盖率 CPU 预算', () => {
  it('两个 workspace 的 llvm-cov 调用都按默认预算 4 限制 --jobs 并导出 RUST_TEST_THREADS（评审 5545658713 owner 指示）', () => {
    const budget = 4
    const result = runCoverage()

    expect(result.status, result.stderr).toBe(0)
    const invocations = result.invocations
      .split('\n')
      .filter((line) => line.startsWith('cargo-llvm-cov'))
    expect(invocations).toHaveLength(2)
    for (const line of invocations) {
      expect(line).toContain(`--jobs ${budget}`)
    }
    expect(result.invocations).toContain(`rust-test-threads ${budget}`)
  })

  it('PLOTWEAVE_GATE_CPU_BUDGET 覆盖默认预算并同步到测试执行并行度', () => {
    const result = runCoverage('valid', 2)

    expect(result.status, result.stderr).toBe(0)
    expect(result.invocations).toContain('--jobs 2')
    expect(result.invocations).toContain('rust-test-threads 2')
  })

  it('非法预算以稳定诊断码阻断，不生成报告', () => {
    const result = runCoverage('valid', 'zero')

    expect(result.status).not.toBe(0)
    // 稳定诊断代码契约：quality-gate-cost.md「Gate CPU Budget」
    expect(result.stderr).toContain('[GATE_CPU_BUDGET_INVALID]')
  })
})
