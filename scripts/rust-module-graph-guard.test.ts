import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

// Rust 模块图守卫元守卫的行为契约（issue #471）：被测对象是
// scripts/check-rust-module-graph-guard.sh——它以 `cargo test --lib --
// --list` 的实际输出为语义依据，断言 `module_graph::` 前缀用例数不低于
// 存活下限 90，使「删除 lib.rs 唯一挂载点 / 清空模块用例」从 cargo test
// 依旧全绿变为元检查失败。真实工具链端到端形态由门禁与 CI 的 rust 任务
// 承担（串行、cargo 已就绪）；本套件以受控 cargo 替身驱动脚本行为——
// 与 sonar-quality-gate.test.ts 的 PLOTWEAVE_*_BIN 替身模式同款，避免在
// 并行 vitest 套件里触发冷 cargo 构建（全核 rustc 会饿死同样 spawn 子
// 进程的兄弟测试，0e80937 推送实测 8 例超时）。

const repositoryRoot = resolve(import.meta.dirname, '..')
const scriptPath = resolve(
  repositoryRoot,
  'scripts/check-rust-module-graph-guard.sh',
)
const temporaryDirectories: string[] = []

/** cargo 替身的受控输出形态。 */
type CargoStubOptions = {
  /** `module_graph::` 前缀用例行数（存活下限 90）。 */
  readonly guardTests: number
  /** 无关用例行：子串或相近前缀命中，不得计入计数。 */
  readonly decoyTests?: readonly string[]
  /** 退出码：非零模拟工具链/编译失败。 */
  readonly exit?: number
}

/** 元守卫脚本的受控运行结果。 */
type MetaGuardRun = {
  readonly log: string
  readonly status: number | null
  readonly stderr: string
  readonly stdout: string
}

/** 创建可执行脚本文件（与门禁测试同款替身写法）。 */
function writeExecutable(path: string, body: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `#!/bin/sh\n${body}\n`)
  chmodSync(path, 0o755)
}

/** 在独立沙箱内组装受控 cargo 替身并运行元守卫脚本：替身记录调用
 * （含工作目录）并按选项输出用例清单；清单混入编译进度型 stderr 噪音
 * 与 cargo 尾部摘要行，验证计数只认 `^module_graph::…: test$` 形态。
 * 根覆盖（PLOTWEAVE_GATE_REPOSITORY_ROOT，issue #405 同款注入点）指向
 * 沙箱，列举命令应在该根下发起、manifest 指向该树的 src-tauri。 */
function runMetaGuard(options: CargoStubOptions): MetaGuardRun {
  const sandbox = mkdtempSync(resolve(tmpdir(), 'plotweave-meta-guard-'))
  temporaryDirectories.push(sandbox)
  const logPath = resolve(sandbox, 'calls.log')
  const cargoPath = resolve(sandbox, 'bin', 'cargo')
  const decoys = options.decoyTests ?? []
  writeExecutable(
    cargoPath,
    String.raw`printf 'cargo pwd=%s args=%s\n' "$(pwd)" "$*" >> "${logPath}"
printf '%s\n' '   Compiling noise v0.0.0' >&2
if [ ${options.exit ?? 0} -ne 0 ]; then
  printf '%s\n' 'error: injected cargo failure (boom-diagnostic)' >&2
  exit ${options.exit ?? 0}
fi
i=0
while [ "$i" -lt ${options.guardTests} ]; do
  printf 'module_graph::case_%s: test\n' "$i"
  i=$((i + 1))
done
${decoys.map((line) => `printf '%s\\n' '${line}'`).join('\n')}
printf '%s tests, 0 benchmarks\n' $((${options.guardTests} + ${decoys.length}))`,
  )
  const result = spawnSync('sh', [scriptPath], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      PLOTWEAVE_GATE_REPOSITORY_ROOT: sandbox,
      PLOTWEAVE_CARGO_BIN: cargoPath,
    },
  })
  return {
    log: readLogBestEffort(logPath),
    status: result.status,
    stderr: result.stderr,
    stdout: result.stdout,
  }
}

/** 尽力读取替身日志：路径缺失时返回空串（门禁测试同款语义）。 */
function readLogBestEffort(path: string): string {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return ''
  }
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('Rust 模块图守卫元守卫脚本契约（issue #471）', () => {
  it('枚举数不低于存活下限：通过并报告实际数量与 cargo 调用形态', () => {
    const result = runMetaGuard({ guardTests: 122 })

    expect(result.status).toBe(0)
    expect(result.stdout).toContain(
      '[meta-guard] 模块图守卫元检查通过：122 个 module_graph:: 用例',
    )
    expect(result.stderr).toBe('')
  })

  it('计数只认行首 module_graph:: 前缀：子串命中与相近前缀不计入', () => {
    const result = runMetaGuard({
      // 恰为存活下限：任何一个真行被误排除会让计数低于 90 而失败，
      // 报错消息里的实际数量可分辨。
      guardTests: 90,
      decoyTests: [
        'quit_gate_tests::buffers_startup_gap_request: test',
        'other::module_graph::substring_hit: test',
        'module_graph_docs::near_prefix: test',
        'module_graph: test',
      ],
    })

    expect(result.status).toBe(0)
    expect(result.stdout).toContain(
      '[meta-guard] 模块图守卫元检查通过：90 个 module_graph:: 用例',
    )
  })

  it('跌破存活下限：失败并指明挂载点（回归即 #471 的缺口形态）', () => {
    const result = runMetaGuard({ guardTests: 5 })

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('守卫用例数 5 跌破存活下限 90')
    expect(result.stderr).toContain('#[cfg(test)] mod module_graph 被移除')
  })

  it('挂载点被删的归零形态：零命中不因 grep 退出码被吞掉，判失败', () => {
    const result = runMetaGuard({
      guardTests: 0,
      decoyTests: ['quit_gate_tests::unrelated: test'],
    })

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('守卫用例数 0 跌破存活下限 90')
  })

  it('cargo 列举失败：fail-closed 且尾部诊断可见', () => {
    const result = runMetaGuard({ guardTests: 122, exit: 101 })

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('cargo test --lib -- --list 失败')
    expect(result.stderr).toContain('boom-diagnostic')
  })

  it('cargo 不可用：fail-closed 报缺少命令', () => {
    const sandbox = mkdtempSync(resolve(tmpdir(), 'plotweave-meta-guard-'))
    temporaryDirectories.push(sandbox)
    const result = spawnSync('sh', [scriptPath], {
      cwd: repositoryRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        PLOTWEAVE_GATE_REPOSITORY_ROOT: sandbox,
        PLOTWEAVE_CARGO_BIN: resolve(sandbox, 'missing-cargo'),
      },
    })

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('缺少命令')
  })

  it('根覆盖生效：列举命令在被检树根下发起，manifest 指向该树', () => {
    const sandbox = mkdtempSync(resolve(tmpdir(), 'plotweave-meta-guard-'))
    temporaryDirectories.push(sandbox)
    const logPath = resolve(sandbox, 'calls.log')
    const cargoPath = resolve(sandbox, 'bin', 'cargo')
    writeExecutable(
      cargoPath,
      String.raw`printf 'cargo pwd=%s args=%s\n' "$(pwd)" "$*" >> "${logPath}"
i=0
while [ "$i" -lt 95 ]; do
  printf 'module_graph::case_%s: test\n' "$i"
  i=$((i + 1))
done`,
    )
    const result = spawnSync('sh', [scriptPath], {
      cwd: repositoryRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        PLOTWEAVE_GATE_REPOSITORY_ROOT: sandbox,
        PLOTWEAVE_CARGO_BIN: cargoPath,
      },
    })

    expect(result.status).toBe(0)
    expect(readLogBestEffort(logPath)).toContain(
      `cargo pwd=${sandbox} args=test --lib --manifest-path src-tauri/Cargo.toml -- --list`,
    )
  })
})
