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

// issues #471/#495：验证真实脚本对 libtest 枚举、逐例执行结果和版本化
// 名称基线的语义判定。Cargo 是缓慢外部边界；真实工具链的变异验证在
// 串行阶段完成，避免并行 Vitest 中的冷构建饿死兄弟子进程测试。
const repositoryRoot = resolve(import.meta.dirname, '..')
const scriptPath = resolve(
  repositoryRoot,
  'scripts/check-rust-module-graph-guard.sh',
)
const temporaryDirectories: string[] = []

/** 外部 Cargo 输出及基线的故障注入；缺省为 149 项完整成功结果。 */
type CargoStubOptions = {
  readonly guardTests?: number
  readonly baselineTests?: number
  readonly baseline?: unknown
  readonly missingBaseline?: boolean
  readonly listingNames?: readonly string[]
  readonly executionNames?: readonly string[]
  readonly decoyTests?: readonly string[]
  readonly ignoredTests?: number
  readonly shouldPanicTests?: number
  readonly exit?: number
  readonly executionExit?: number
  readonly summary?: string | null
}

/** 真实元守卫脚本的可观察结果。 */
type MetaGuardRun = {
  readonly log: string
  readonly status: number | null
  readonly stderr: string
  readonly stdout: string
}

/** 生成仅供 libtest 协议夹具使用的具名用例。 */
function caseNames(count: number): string[] {
  return Array.from(
    { length: count },
    (_, index) => `module_graph::case_${index}`,
  )
}

/** 创建完整 libtest 协议夹具：列举与执行可独立失效。 */
function writeCargoStub(sandbox: string, options: CargoStubOptions): string {
  const cargoPath = resolve(sandbox, 'cargo')
  const names = caseNames(options.guardTests ?? 149)
  const executionNames = options.executionNames ?? names
  const ignored = options.ignoredTests ?? 0
  const payload = {
    ...options,
    listing: [
      ...(options.listingNames ?? names).map((name) => `${name}: test`),
      ...(options.decoyTests ?? []),
    ],
    execution: executionNames.map(
      (name, index) =>
        `test ${name}${index < (options.shouldPanicTests ?? 0) ? ' - should panic' : ''} ... ${index < ignored ? 'ignored' : 'ok'}`,
    ),
    summary:
      options.summary === undefined
        ? `test result: ok. ${executionNames.length - ignored} passed; 0 failed; ${ignored} ignored; 0 measured; 514 filtered out; finished in 0.00s`
        : options.summary,
  }
  writeFileSync(resolve(sandbox, 'cargo-output.json'), JSON.stringify(payload))
  writeFileSync(
    cargoPath,
    `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const root = path.dirname(__filename);
const options = JSON.parse(fs.readFileSync(path.join(root, 'cargo-output.json'), 'utf8'));
fs.appendFileSync(path.join(root, 'calls.log'), 'cargo pwd=' + process.cwd() + ' args=' + process.argv.slice(2).join(' ') + '\\n');
process.stderr.write('   Compiling noise v0.0.0\\n');
const listing = process.argv.includes('--list');
const code = listing ? options.exit : options.executionExit;
if (code) {
  process.stderr.write('error: injected cargo failure (boom-diagnostic)\\n');
  process.exit(code);
}
process.stdout.write((listing ? options.listing : options.execution).join('\\n') + '\\n');
if (listing) process.stdout.write(options.listing.length + ' tests, 0 benchmarks\\n');
else if (options.summary !== null) process.stdout.write(options.summary + '\\n');
`,
    { mode: 0o755 },
  )
  return cargoPath
}

/** 在根覆盖沙箱中运行脚本；基线与 Cargo 输出属于被检查树。 */
function runMetaGuard(options: CargoStubOptions = {}): MetaGuardRun {
  const sandbox = mkdtempSync(resolve(tmpdir(), 'plotweave-meta-guard-'))
  temporaryDirectories.push(sandbox)
  mkdirSync(resolve(sandbox, 'scripts'))
  if (!options.missingBaseline) {
    writeFileSync(
      resolve(sandbox, 'scripts/rust-module-graph-guard-baseline.json'),
      JSON.stringify(
        options.baseline ?? {
          version: 1,
          tests: caseNames(options.baselineTests ?? 149),
        },
      ),
    )
  }
  const result = spawnSync('sh', [scriptPath], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      PLOTWEAVE_GATE_REPOSITORY_ROOT: sandbox,
      PLOTWEAVE_CARGO_BIN: writeCargoStub(sandbox, options),
    },
  })
  return {
    log: readFileSync(resolve(sandbox, 'calls.log'), {
      encoding: 'utf8',
      flag: 'a+',
    }),
    status: result.status,
    stderr: result.stderr,
    stdout: result.stdout,
  }
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0))
    rmSync(directory, { recursive: true, force: true })
})

describe('Rust 模块图守卫元守卫脚本契约（issues #471/#495）', () => {
  it('完整注册的守卫全部被忽略时失败（issue #495 回归）', () => {
    expect(runMetaGuard({ ignoredTests: 149 }).status).toBe(1)
  })

  it('一个守卫被忽略仍必须失败', () => {
    expect(runMetaGuard({ ignoredTests: 1 }).status).toBe(1)
  })

  it('基线中的全部用例实际通过才成功', () => {
    const result = runMetaGuard()
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('149')
    expect(result.stderr).toBe('')
    expect(result.log).toContain(
      'args=test --lib --manifest-path src-tauri/Cargo.toml -- --list',
    )
    expect(result.log).toContain(
      'args=test --lib --manifest-path src-tauri/Cargo.toml -- module_graph:: --format pretty --color never --test-threads=1',
    )
    const roots = result.log
      .split('\n')
      .filter(Boolean)
      .map((line) => line.split(' args=')[0])
    expect(new Set(roots).size).toBe(1)
  })

  it('无关、子串和相近前缀注册项不能影响守卫清单', () => {
    const result = runMetaGuard({
      decoyTests: [
        'quit_gate_tests::unrelated: test',
        'other::module_graph::substring_hit: test',
        'module_graph_docs::near_prefix: test',
        'module_graph: test',
      ],
    })
    expect(result.status).toBe(0)
  })
})

describe('守卫注册基线的名称与增长约束', () => {
  it.each([0, 5, 90, 140, 148])(
    '注册项缩减至 %s 时失败并指明挂载点',
    (guardTests) => {
      const result = runMetaGuard({ guardTests })
      expect(result.status).toBe(1)
      expect(result.stderr).toContain(
        `守卫用例数 ${guardTests} 跌破存活下限 149`,
      )
      expect(result.stderr).toContain('#[cfg(test)] mod module_graph 被移除')
    },
  )

  it('新增用例必须同步提高版本化基线', () => {
    expect(runMetaGuard({ guardTests: 150 }).status).toBe(1)
    expect(runMetaGuard({ guardTests: 150, baselineTests: 150 }).status).toBe(0)
    expect(runMetaGuard({ guardTests: 149, baselineTests: 150 }).status).toBe(1)
  })

  it('同数量的其他具名桩不能补足被删除的用例', () => {
    expect(
      runMetaGuard({
        listingNames: [...caseNames(148), 'module_graph::replacement'],
      }).status,
    ).toBe(1)
  })

  it('注册顺序变化不改变名称集合', () => {
    expect(
      runMetaGuard({ listingNames: caseNames(149).reverse() }).status,
    ).toBe(0)
  })

  it('重复注册项不能补足缺少的名称', () => {
    expect(
      runMetaGuard({
        listingNames: [...caseNames(148), 'module_graph::case_0'],
      }).status,
    ).toBe(1)
  })
})

describe('守卫实际执行与摘要一致性', () => {
  it('预期 panic 的守卫也按实际通过计入', () => {
    expect(runMetaGuard({ shouldPanicTests: 3 }).status).toBe(0)
  })

  it('无关的执行成功不能补足未执行的守卫', () => {
    expect(
      runMetaGuard({
        executionNames: [...caseNames(148), 'other::module_graph::decoy'],
      }).status,
    ).toBe(1)
  })

  it('同数量的执行替名与重复执行均失败', () => {
    expect(
      runMetaGuard({
        executionNames: [...caseNames(148), 'module_graph::replacement'],
      }).status,
    ).toBe(1)
    expect(
      runMetaGuard({
        executionNames: [...caseNames(148), 'module_graph::case_0'],
      }).status,
    ).toBe(1)
  })

  it.each([
    null,
    'test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 514 filtered out; finished in 0.00s',
    'test result: ok. 149 passed; 0 failed; 1 ignored; 0 measured; 514 filtered out; finished in 0.00s',
    'test result: FAILED. 149 passed; 1 failed; 0 ignored; 0 measured; 514 filtered out; finished in 0.00s',
    'test result: ok. malformed',
    'test result: ok. 149 passed; 0 failed; 0 ignored; 0 measured; 514 filtered out; finished in 0.00s\ntest result: ok. 149 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s',
  ])('缺失、畸形或不一致的执行摘要失败：%s', (summary) => {
    expect(runMetaGuard({ summary }).status).toBe(1)
  })
})

describe('工具链与版本化基线的失败边界', () => {
  it.each(['exit', 'executionExit'] as const)(
    'Cargo %s 失败时保留诊断并 fail-closed',
    (stage) => {
      const result = runMetaGuard({ [stage]: 101 })
      expect(result.status).toBe(1)
      expect(result.stderr).toContain('boom-diagnostic')
    },
  )

  it.each([
    { version: 2, tests: caseNames(149) },
    { version: 1, tests: [] },
    { version: 1, tests: ['other::case'] },
    { version: 1, tests: ['module_graph::case', 'module_graph::case'] },
    { version: 1, tests: [null] },
  ])('非法或重复基线 fail-closed：%j', (baseline) => {
    expect(runMetaGuard({ baseline }).status).toBe(1)
  })

  it('缺少基线 fail-closed', () => {
    expect(runMetaGuard({ missingBaseline: true }).status).toBe(1)
  })

  it('Cargo 不可用时 fail-closed', () => {
    const result = spawnSync('sh', [scriptPath], {
      cwd: repositoryRoot,
      encoding: 'utf8',
      env: { ...process.env, PLOTWEAVE_CARGO_BIN: '/missing-plotweave-cargo' },
    })
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('缺少命令')
  })
})
