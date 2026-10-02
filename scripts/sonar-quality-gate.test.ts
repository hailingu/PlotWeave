import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'

const repositoryRoot = resolve(import.meta.dirname, '..')
const temporaryDirectories: string[] = []

type GateOptions = {
  coverageMode?:
    | 'atFloor'
    | 'belowFloor'
    | 'empty'
    | 'malformed'
    | 'missing'
    | 'partial'
    | 'uncovered'
    | 'valid'
  formatExit?: number
  lintExit?: number
  lockName?: string
  lockOccupied?: boolean
  npmExit?: number
  pendingBlocked?: boolean
  pendingSeed?: string
  plotweaveSonarToken?: string
  rustCoverageMode?:
    | 'atFloor'
    | 'belowFloor'
    | 'empty'
    | 'malformed'
    | 'missing'
    | 'partial'
    | 'roundsToFloor'
    | 'uncovered'
    | 'valid'
  scannerExit?: number
  strictIndexExit?: number
  qualityGateStatus?: string
  sonarHostUrl?: string | null
  sonarToken?: string
  unresolvedIssues?: number
}

type GateRun = {
  curlStdin: string
  history: string
  log: string
  lockExists: boolean
  marker: string
  pending: string
  scannerToken: string
  status: number | null
  stderr: string
  stdout: string
}

/** 创建一个仅记录调用并返回受控结果的外部命令替身。 */
function writeExecutable(path: string, body: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `#!/bin/sh\n${body}\n`)
  chmodSync(path, 0o755)
}

/** 尽力读取沙箱输出文件：路径缺失或被目录占据（不可写注入形态）时返回
 * 空串——目录占位对 root 也无条件不可追加（PR #415 评审 5339054039）。 */
function readTextFileBestEffort(path: string): string {
  try {
    return readFileSync(path, { encoding: 'utf8' })
  } catch {
    return ''
  }
}

/** runGate 的命令替身路径集（sandbox 内固定布局）。 */
interface GateStubPaths {
  readonly logPath: string
  readonly curlStdinPath: string
  readonly scannerTokenPath: string
  readonly coveragePath: string
  readonly rustCoveragePath: string
  readonly historyPath: string
  readonly pendingPath: string
  readonly markerPath: string
  readonly lockPath: string
  readonly reportPath: string
  readonly npmPath: string
  readonly scannerPath: string
  readonly curlPath: string
  readonly llvmCovPath: string
}

/** npm 替身（writeCommandStubs 拆分，PR #415 评审 5339054039）：记录
 * 调用并按环境注入静态检查/覆盖率生成结果——格式/lint 可独立注入失败
 *（issue #227）；覆盖率只在 test:coverage 生成（避免格式调用顺带写出
 * 报告，掩盖失败路径），形态见 PLOTWEAVE_TEST_COVERAGE_MODE。 */
function writeNpmStub(paths: GateStubPaths): void {
  writeExecutable(
    paths.npmPath,
    String.raw`printf 'npm %s\n' "$*" >> "$PLOTWEAVE_TEST_LOG"
[ -z "$SONAR_TOKEN$PLOTWEAVE_SONAR_TOKEN$sonar_token" ] || printf 'npm-token-present\n' >> "$PLOTWEAVE_TEST_LOG"
# 静态检查子命令（issue #227）：格式/lint 可独立注入失败；覆盖率只在
# test:coverage 生成（避免格式调用顺带写出报告，掩盖失败路径）
if [ "$*" = "run format:check" ]; then
  exit "$PLOTWEAVE_TEST_FORMAT_EXIT"
fi
if [ "$*" = "run lint -- --max-warnings=0" ]; then
  exit "$PLOTWEAVE_TEST_LINT_EXIT"
fi
if [ "$*" = "run typecheck:strict" ]; then
  exit "$PLOTWEAVE_TEST_STRICT_INDEX_EXIT"
fi
if [ "$PLOTWEAVE_TEST_NPM_EXIT" -ne 0 ]; then
  exit "$PLOTWEAVE_TEST_NPM_EXIT"
fi
if [ "$*" != "run test:coverage" ]; then
  exit 0
fi
case "$PLOTWEAVE_TEST_COVERAGE_MODE" in
  valid)
    mkdir -p "$(dirname "$PLOTWEAVE_COVERAGE_REPORT_PATH")"
    printf '%s\n' 'TN:' 'SF:src/example.ts' 'DA:1,1' 'end_of_record' > "$PLOTWEAVE_COVERAGE_REPORT_PATH"
    ;;
  # partial（9/10 = 90.00%）与 atFloor（4/5 = 80.00%）均高于/恰在下限：
  # partial 供台账非整数值断言，atFloor 供「等于下限通过」边界断言
  #（issue #393）；belowFloor（1/2 = 50.00%）通过非空与已覆盖校验、
  # 只跌破产线复核。
  partial)
    mkdir -p "$(dirname "$PLOTWEAVE_COVERAGE_REPORT_PATH")"
    printf '%s\n' 'TN:' 'SF:src/example.ts' 'DA:1,1' 'DA:2,1' 'DA:3,1' 'DA:4,1' 'DA:5,1' 'DA:6,1' 'DA:7,1' 'DA:8,1' 'DA:9,1' 'DA:10,0' 'end_of_record' > "$PLOTWEAVE_COVERAGE_REPORT_PATH"
    ;;
  atFloor)
    mkdir -p "$(dirname "$PLOTWEAVE_COVERAGE_REPORT_PATH")"
    printf '%s\n' 'TN:' 'SF:src/example.ts' 'DA:1,1' 'DA:2,1' 'DA:3,1' 'DA:4,1' 'DA:5,0' 'end_of_record' > "$PLOTWEAVE_COVERAGE_REPORT_PATH"
    ;;
  belowFloor)
    mkdir -p "$(dirname "$PLOTWEAVE_COVERAGE_REPORT_PATH")"
    printf '%s\n' 'TN:' 'SF:src/example.ts' 'DA:1,1' 'DA:2,0' 'end_of_record' > "$PLOTWEAVE_COVERAGE_REPORT_PATH"
    ;;
  empty)
    mkdir -p "$(dirname "$PLOTWEAVE_COVERAGE_REPORT_PATH")"
    : > "$PLOTWEAVE_COVERAGE_REPORT_PATH"
    ;;
  malformed)
    mkdir -p "$(dirname "$PLOTWEAVE_COVERAGE_REPORT_PATH")"
    printf '%s\n' 'TN:' 'end_of_record' > "$PLOTWEAVE_COVERAGE_REPORT_PATH"
    ;;
  uncovered)
    mkdir -p "$(dirname "$PLOTWEAVE_COVERAGE_REPORT_PATH")"
    printf '%s\n' 'TN:' 'SF:src/example.ts' 'DA:1,0' 'end_of_record' > "$PLOTWEAVE_COVERAGE_REPORT_PATH"
    ;;
esac`,
  )
}

/** Rust 覆盖率替身（writeCommandStubs 拆分；issue #169）：cargo-llvm-cov
 * 的记录-并-受控返回替身，按选项预置 LCOV 形态；missing 模式不创建
 * 文件（生成缺失）。 */
function writeRustCoverageStub(paths: GateStubPaths): void {
  writeExecutable(
    paths.llvmCovPath,
    String.raw`printf 'cargo-llvm-cov %s\n' "$*" >> "$PLOTWEAVE_TEST_LOG"
[ -z "$SONAR_TOKEN$PLOTWEAVE_SONAR_TOKEN$sonar_token" ] || printf 'rust-token-present\n' >> "$PLOTWEAVE_TEST_LOG"
case "$PLOTWEAVE_TEST_RUST_COVERAGE_MODE" in
  valid)
    printf '%s\n' 'TN:' 'SF:src-tauri/src/example.rs' 'DA:1,1' 'end_of_record' > "$PLOTWEAVE_RUST_COVERAGE_REPORT_PATH"
    ;;
  partial)
    printf '%s\n' 'TN:' 'SF:src-tauri/src/example.rs' 'DA:1,1' 'DA:2,1' 'DA:3,1' 'DA:4,1' 'DA:5,1' 'DA:6,1' 'DA:7,1' 'DA:8,1' 'DA:9,1' 'DA:10,0' 'end_of_record' > "$PLOTWEAVE_RUST_COVERAGE_REPORT_PATH"
    ;;
  atFloor)
    printf '%s\n' 'TN:' 'SF:src-tauri/src/example.rs' 'DA:1,1' 'DA:2,1' 'DA:3,1' 'DA:4,1' 'DA:5,0' 'end_of_record' > "$PLOTWEAVE_RUST_COVERAGE_REPORT_PATH"
    ;;
  belowFloor)
    printf '%s\n' 'TN:' 'SF:src-tauri/src/example.rs' 'DA:1,1' 'DA:2,0' 'end_of_record' > "$PLOTWEAVE_RUST_COVERAGE_REPORT_PATH"
    ;;
  empty)
    : > "$PLOTWEAVE_RUST_COVERAGE_REPORT_PATH"
    ;;
  malformed)
    printf '%s\n' 'TN:' 'end_of_record' > "$PLOTWEAVE_RUST_COVERAGE_REPORT_PATH"
    ;;
  uncovered)
    printf '%s\n' 'TN:' 'SF:src-tauri/src/example.rs' 'DA:1,0' 'end_of_record' > "$PLOTWEAVE_RUST_COVERAGE_REPORT_PATH"
    ;;
  # roundsToFloor：79998/100000 = 79.998% < 80，但 %.2f 取整后显示 80.00%
  #——下限比较必须用未取整的命中/总数，取整到下限边界的形态也要阻断
  #（PR #422 评审 5347340194，Rust 无前端侧 Vitest 阈值的独立第二层）。
  roundsToFloor)
    { printf '%s\n' 'TN:' 'SF:src-tauri/src/example.rs'
      awk 'BEGIN { for (i = 1; i <= 100000; i++) printf "DA:%d,%d\n", i, (i <= 79998) }'
      printf '%s\n' 'end_of_record'; } > "$PLOTWEAVE_RUST_COVERAGE_REPORT_PATH"
    ;;
esac`,
  )
}

/** sonar-scanner 替身（writeCommandStubs 拆分）：记录调用与令牌接收形
 * 态，受控退出，并写出 report-task.txt 供门禁读取。 */
function writeScannerStub(paths: GateStubPaths): void {
  writeExecutable(
    paths.scannerPath,
    String.raw`printf 'sonar-scanner %s\n' "$*" >> "$PLOTWEAVE_TEST_LOG"
printf '%s' "$SONAR_TOKEN" > "$PLOTWEAVE_TEST_SCANNER_TOKEN"
if [ "$PLOTWEAVE_TEST_SCANNER_EXIT" -ne 0 ]; then
  exit "$PLOTWEAVE_TEST_SCANNER_EXIT"
fi
mkdir -p "$(dirname "$PLOTWEAVE_SONAR_REPORT_PATH")"
printf '%s\n' \
  'projectKey=PlotWeave' \
  'serverUrl=http://sonar.test' \
  > "$PLOTWEAVE_SONAR_REPORT_PATH"`,
  )
}

/** curl 替身（writeCommandStubs 拆分）：记录调用并按 URL 返回受控的
 * Quality Gate 状态与新增未解决问题数，stdin 捕获认证头下发形态。 */
function writeCurlStub(paths: GateStubPaths): void {
  writeExecutable(
    paths.curlPath,
    String.raw`printf 'curl %s\n' "$*" >> "$PLOTWEAVE_TEST_LOG"
cat > "$PLOTWEAVE_TEST_CURL_STDIN"
case "$*" in
  *qualitygates/project_status*)
    printf '{"projectStatus":{"status":"%s"}}' "$PLOTWEAVE_TEST_QUALITY_GATE_STATUS"
    ;;
  *api/issues/search*)
    printf '{"total":%s}' "$PLOTWEAVE_TEST_UNRESOLVED_ISSUES"
    ;;
  *)
    printf '%s\n' 'unexpected curl URL' >&2
    exit 64
    ;;
esac`,
  )
}

/** 外部命令替身总装（runGate 拆分，issue #99）：npm / cargo-llvm-cov /
 * sonar-scanner / curl 的记录-并-受控返回替身，按选项预置锁形态。 */
function writeCommandStubs(paths: GateStubPaths, options: GateOptions): void {
  writeNpmStub(paths)
  writeRustCoverageStub(paths)
  writeScannerStub(paths)
  writeCurlStub(paths)

  if (options.lockOccupied) {
    mkdirSync(paths.lockPath)
  }
}

/** 门禁运行环境（runGate 拆分，issue #99）：替身路径 + 受控选项；令牌不
 * 继承宿主环境（默认无令牌，按用例显式注入）。 */
function gateEnvironment(
  paths: GateStubPaths,
  options: GateOptions,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    PLOTWEAVE_CARGO_LLVM_COV_BIN: paths.llvmCovPath,
    PLOTWEAVE_CURL_BIN: paths.curlPath,
    PLOTWEAVE_COVERAGE_REPORT_PATH: paths.coveragePath,
    PLOTWEAVE_GATE_HISTORY_PATH: paths.historyPath,
    PLOTWEAVE_GATE_MARKER_PATH: paths.markerPath,
    PLOTWEAVE_GATE_PENDING_PATH: paths.pendingPath,
    PLOTWEAVE_RUST_COVERAGE_REPORT_PATH: paths.rustCoveragePath,
    PLOTWEAVE_SONAR_LOCK_DIRECTORY: paths.lockPath,
    PLOTWEAVE_NODE_BIN: process.execPath,
    PLOTWEAVE_NPM_BIN: paths.npmPath,
    PLOTWEAVE_SONAR_REPORT_PATH: paths.reportPath,
    PLOTWEAVE_SONAR_SCANNER_BIN: paths.scannerPath,
    PLOTWEAVE_TEST_LOG: paths.logPath,
    PLOTWEAVE_TEST_CURL_STDIN: paths.curlStdinPath,
    PLOTWEAVE_TEST_SCANNER_TOKEN: paths.scannerTokenPath,
    PLOTWEAVE_TEST_COVERAGE_MODE: options.coverageMode ?? 'valid',
    PLOTWEAVE_TEST_FORMAT_EXIT: String(options.formatExit ?? 0),
    PLOTWEAVE_TEST_LINT_EXIT: String(options.lintExit ?? 0),
    PLOTWEAVE_TEST_RUST_COVERAGE_MODE: options.rustCoverageMode ?? 'valid',
    PLOTWEAVE_TEST_NPM_EXIT: String(options.npmExit ?? 0),
    PLOTWEAVE_TEST_QUALITY_GATE_STATUS: options.qualityGateStatus ?? 'OK',
    PLOTWEAVE_TEST_SCANNER_EXIT: String(options.scannerExit ?? 0),
    PLOTWEAVE_TEST_STRICT_INDEX_EXIT: String(options.strictIndexExit ?? 0),
    PLOTWEAVE_TEST_UNRESOLVED_ISSUES: String(options.unresolvedIssues ?? 0),
    SONAR_HOST_URL: options.sonarHostUrl ?? 'http://sonar.test',
  }
  if (options.sonarHostUrl === null) {
    delete environment.SONAR_HOST_URL
  }
  // 令牌不继承宿主环境：默认无令牌，按用例显式注入
  delete environment.SONAR_TOKEN
  delete environment.PLOTWEAVE_SONAR_TOKEN
  if (options.sonarToken !== undefined) {
    environment.SONAR_TOKEN = options.sonarToken
  }
  if (options.plotweaveSonarToken !== undefined) {
    environment.PLOTWEAVE_SONAR_TOKEN = options.plotweaveSonarToken
  }
  return environment
}

/** 为同步运行与强杀恢复场景分配同一个隔离门禁沙箱。 */
function prepareGatePaths(options: GateOptions = {}): GateStubPaths {
  const sandbox = mkdtempSync(resolve(tmpdir(), 'plotweave-sonar-gate-'))
  temporaryDirectories.push(sandbox)

  const paths: GateStubPaths = {
    logPath: resolve(sandbox, 'calls.log'),
    curlStdinPath: resolve(sandbox, 'curl-stdin.txt'),
    scannerTokenPath: resolve(sandbox, 'scanner-token.txt'),
    coveragePath: resolve(sandbox, 'coverage', 'lcov.info'),
    rustCoveragePath: resolve(sandbox, 'rust-coverage', 'lcov-rust.info'),
    historyPath: resolve(sandbox, 'gate-history.jsonl'),
    pendingPath: resolve(sandbox, 'gate-pending.jsonl'),
    markerPath: resolve(sandbox, 'gate-tree.marker'),
    lockPath: resolve(sandbox, options.lockName ?? 'sonar-gate.lock'),
    reportPath: resolve(sandbox, '.scannerwork', 'report-task.txt'),
    npmPath: resolve(sandbox, 'bin', 'npm'),
    scannerPath: resolve(sandbox, 'bin', 'sonar-scanner'),
    curlPath: resolve(sandbox, 'bin', 'curl'),
    llvmCovPath: resolve(sandbox, 'bin', 'cargo-llvm-cov'),
  }

  writeCommandStubs(paths, options)

  // 版本化与待物化文件预置：待物化默认为空（失败路径不追加时读到空
  // 串），可种子验证追加不覆盖；blocked 形态以目录占位使追加无条件失败
  // （root 亦然），验证「写不进不阻塞门禁」（issue #355，PR #415 评审
  // 5339054039）。版本化文件保持空串以断言门禁运行绝不直接触碰它。
  writeFileSync(paths.historyPath, '')
  if (options.pendingBlocked) {
    mkdirSync(paths.pendingPath)
  } else {
    writeFileSync(paths.pendingPath, '')
    if (options.pendingSeed !== undefined) {
      writeFileSync(paths.pendingPath, `${options.pendingSeed}\n`)
    }
  }

  return paths
}

/** 使用指定沙箱执行真实门禁，可在清理残留锁后重试同一路径。 */
function runPreparedGate(
  target: string,
  paths: GateStubPaths,
  options: GateOptions = {},
): GateRun {
  const result = spawnSync('sh', [resolve(repositoryRoot, target)], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    env: gateEnvironment(paths, options),
  })

  return {
    curlStdin: readFileSync(paths.curlStdinPath, {
      encoding: 'utf8',
      flag: 'a+',
    }),
    history: readFileSync(paths.historyPath, { encoding: 'utf8' }),
    log: readFileSync(paths.logPath, { encoding: 'utf8', flag: 'a+' }),
    lockExists: existsSync(paths.lockPath),
    marker: readTextFileBestEffort(paths.markerPath),
    pending: readTextFileBestEffort(paths.pendingPath),
    scannerToken: readFileSync(paths.scannerTokenPath, {
      encoding: 'utf8',
      flag: 'a+',
    }),
    status: result.status,
    stderr: result.stderr,
    stdout: result.stdout,
  }
}

/** 在隔离的外部依赖边界下执行真实门禁脚本或 Git hook。 */
function runGate(target: string, options: GateOptions = {}): GateRun {
  return runPreparedGate(target, prepareGatePaths(options), options)
}

/** 等待测试门禁在持锁后的首个检查命令中暂停，超时或提前退出均报错。 */
function waitForHeldGate(child: ChildProcess): Promise<void> {
  return new Promise((resolveReady, reject) => {
    const timeout = setTimeout(
      () => reject(new Error('测试门禁未在持锁后就绪')),
      10_000,
    )
    let output = ''
    child.once('error', (error) => {
      clearTimeout(timeout)
      reject(error)
    })
    child.once('exit', () => {
      clearTimeout(timeout)
      reject(new Error('测试门禁在持锁就绪前退出'))
    })
    child.stdout?.on('data', (data: Buffer) => {
      output += data.toString()
      if (output.includes('TEST_GATE_LOCK_HELD')) {
        clearTimeout(timeout)
        resolveReady()
      }
    })
  })
}

/** 只终止测试新建的进程组，等待退出以避免检查命令遗留在后台。 */
async function killTestGateGroup(child: ChildProcess): Promise<void> {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return
  const exited = once(child, 'exit')
  process.kill(-child.pid, 'SIGKILL')
  await exited
}

/** 从文档定义的稳定诊断代码读取恢复命令，缺失指引应直接使回归失败。 */
function recoveryCommand(result: GateRun): string {
  // 命令契约：quality-gate-cost.md「门禁锁的人工恢复（Issue #430）」。
  expect(result.stderr).toContain('[SONAR_GATE_LOCK_UNAVAILABLE]')
  const command = result.stderr.match(
    /^\[SONAR_GATE_LOCK_RECOVERY_COMMAND\] (.+)$/m,
  )?.[1]
  expect(command).toBeDefined()
  return command ?? ''
}

afterEach(() => {
  vi.unstubAllEnvs()
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

// 用例逐个 spawnSync 真实门禁脚本（多级 shell 替身），全量套件并发负载下
// 单用例常超 vitest 默认 5s（实测 3.4–4.9s 贴边抖动，钩子内必超）——放宽
// describe 级超时上限，不放宽断言。
describe('SonarQube 提交门禁', { timeout: 30_000 }, () => {
  it('先生成前端与 Rust 覆盖率，再等待 Quality Gate，并确认新增代码未解决问题为零', () => {
    const result = runGate('scripts/sonar-quality-gate.sh')

    expect(result.status).toBe(0)
    expect(
      result.log
        .split('\n')
        .filter(Boolean)
        .map((line) => line.split(' ')[0]),
    ).toEqual([
      'npm',
      'npm',
      'npm',
      'npm',
      'cargo-llvm-cov',
      'sonar-scanner',
      'curl',
      'curl',
    ])
    expect(result.log).toContain('npm run format:check')
    expect(result.log).toContain('npm run lint -- --max-warnings=0')
    expect(result.log).toContain('npm run typecheck:strict')
    expect(result.log).toContain('npm run test:coverage')
    expect(result.log).toContain(
      'cargo-llvm-cov llvm-cov --lib --test media_format_leaf --lcov',
    )
    expect(result.log).toContain('-Dsonar.qualitygate.wait=true')
    expect(result.log).toContain('-Dsonar.host.url=http://sonar.test')
    expect(result.log).toContain('-Dsonar.javascript.lcov.reportPaths=')
    expect(result.log).toContain('/coverage/lcov.info')
    // Rust 覆盖率（issue #169）：与前端一并导入质量报告
    expect(result.log).toContain('-Dsonar.rust.lcov.reportPaths=')
    expect(result.log).toContain('/lcov-rust.info')
    // 增量清零：issues 查询按 sinceLeakPeriod（New Code 周期）过滤
    expect(result.log).toContain('sinceLeakPeriod=true')
  })

  it('Rust 覆盖率生成缺失或没有任何已覆盖行时停止，不启动扫描（issue #169）', () => {
    for (const rustCoverageMode of [
      'missing',
      'empty',
      'malformed',
      'uncovered',
    ] as const) {
      const result = runGate('scripts/sonar-quality-gate.sh', {
        rustCoverageMode,
      })

      expect(result.status, `模式 ${rustCoverageMode}`).not.toBe(0)
      expect(result.log, `模式 ${rustCoverageMode}`).toContain('cargo-llvm-cov')
      expect(result.log, `模式 ${rustCoverageMode}`).not.toContain(
        'sonar-scanner',
      )
    }
  })

  it('前端行覆盖率跌破仓库下限 80% 时停止，不生成 Rust 覆盖率也不扫描（issue #393）', () => {
    const result = runGate('scripts/sonar-quality-gate.sh', {
      coverageMode: 'belowFloor',
    })

    expect(result.status).not.toBe(0)
    expect(result.log).toContain('npm run test:coverage')
    expect(result.log).not.toContain('cargo-llvm-cov')
    expect(result.log).not.toContain('sonar-scanner')
    expect(`${result.stdout}${result.stderr}`).toContain('低于仓库下限')
  })

  it('Rust 行覆盖率跌破仓库下限 80% 时停止，不启动扫描（issue #393）', () => {
    const result = runGate('scripts/sonar-quality-gate.sh', {
      rustCoverageMode: 'belowFloor',
    })

    expect(result.status).not.toBe(0)
    expect(result.log).toContain('cargo-llvm-cov')
    expect(result.log).not.toContain('sonar-scanner')
    expect(`${result.stdout}${result.stderr}`).toContain('低于仓库下限')
  })

  it('真值低于下限但 %.2f 取整为 80.00% 的 Rust 报告仍被阻断（PR #422 评审 5347340194）', () => {
    const result = runGate('scripts/sonar-quality-gate.sh', {
      rustCoverageMode: 'roundsToFloor',
    })

    expect(result.status).not.toBe(0)
    expect(result.log).toContain('cargo-llvm-cov')
    expect(result.log).not.toContain('sonar-scanner')
    expect(`${result.stdout}${result.stderr}`).toContain('低于仓库下限')
  })

  it('两侧行覆盖率恰好等于下限 80% 时通过——下限为 ≥，与服务端「低于才失败」语义一致（issue #393）', () => {
    const result = runGate('scripts/sonar-quality-gate.sh', {
      coverageMode: 'atFloor',
      rustCoverageMode: 'atFloor',
    })

    expect(result.status).toBe(0)
    const [line] = result.pending.split('\n').filter(Boolean)
    const record = JSON.parse(line ?? '')
    expect(record.frontendLineCoveragePercent).toBe(80)
    expect(record.rustLineCoveragePercent).toBe(80)
  })

  it('格式检查失败时阻止操作，不生成覆盖率也不扫描（issue #227）', () => {
    const result = runGate('scripts/sonar-quality-gate.sh', { formatExit: 1 })

    expect(result.status).not.toBe(0)
    expect(result.log).toContain('npm run format:check')
    expect(result.log).not.toContain('test:coverage')
    expect(result.log).not.toContain('sonar-scanner')
  })

  it('lint 零警告失败时阻止操作，不进入扫描（issue #227）', () => {
    const result = runGate('scripts/sonar-quality-gate.sh', { lintExit: 1 })

    expect(result.status).not.toBe(0)
    expect(result.log).toContain('npm run lint -- --max-warnings=0')
    expect(result.log).not.toContain('sonar-scanner')
  })

  it('严格索引类型检查失败时阻止操作，不生成覆盖率也不扫描（issue #230）', () => {
    const result = runGate('scripts/sonar-quality-gate.sh', {
      strictIndexExit: 1,
    })

    expect(result.status).not.toBe(0)
    expect(result.log).toContain('npm run typecheck:strict')
    expect(result.log).not.toContain('test:coverage')
    expect(result.log).not.toContain('sonar-scanner')
  })

  it('未显式配置 SonarQube 地址时阻止操作，避免误扫 SonarQube Cloud', () => {
    const result = runGate('scripts/sonar-quality-gate.sh', {
      sonarHostUrl: null,
    })

    expect(result.status).not.toBe(0)
    expect(result.log).toBe('')
    expect(`${result.stdout}${result.stderr}`).toContain('SONAR_HOST_URL')
  })

  it('覆盖率生成失败时停止，不启动扫描', () => {
    const result = runGate('scripts/sonar-quality-gate.sh', { npmExit: 1 })

    expect(result.status).not.toBe(0)
    expect(result.log).toContain('npm run test:coverage')
    expect(result.log).not.toContain('sonar-scanner')
  })

  it.each(['missing', 'empty', 'malformed', 'uncovered'] as const)(
    '覆盖率报告为 %s 时停止，不发布破坏性分析',
    (coverageMode) => {
      const result = runGate('scripts/sonar-quality-gate.sh', { coverageMode })

      expect(result.status).not.toBe(0)
      expect(result.log).toContain('npm run test:coverage')
      expect(result.log).not.toContain('sonar-scanner')
      expect(`${result.stdout}${result.stderr}`).toContain('覆盖率报告')
    },
  )

  it('另一个门禁正在运行时停止，避免共享扫描目录互相覆盖', () => {
    const result = runGate('scripts/sonar-quality-gate.sh', {
      lockOccupied: true,
    })

    expect(result.status).not.toBe(0)
    expect(result.log).toBe('')
    expect(`${result.stdout}${result.stderr}`).toContain('正在运行')
  })

  it('扫描器失败时停止，不接受旧的服务器结果', () => {
    const result = runGate('scripts/sonar-quality-gate.sh', { scannerExit: 2 })

    expect(result.status).not.toBe(0)
    expect(result.log).toContain('sonar-scanner')
    expect(result.log).not.toContain('curl')
  })

  it('Quality Gate 非 OK 时阻止提交', () => {
    const result = runGate('scripts/sonar-quality-gate.sh', {
      qualityGateStatus: 'ERROR',
    })

    expect(result.status).not.toBe(0)
    expect(`${result.stdout}${result.stderr}`).toContain('Quality Gate')
  })

  it('新增代码仍有未解决问题时阻止提交', () => {
    const result = runGate('scripts/sonar-quality-gate.sh', {
      unresolvedIssues: 3,
    })

    expect(result.status).not.toBe(0)
    expect(`${result.stdout}${result.stderr}`).toContain('3')
  })

  it('SONAR_TOKEN 经 curl 标准输入传 Authorization 头并以环境变量供扫描器，不进入命令参数或调用日志', () => {
    const result = runGate('scripts/sonar-quality-gate.sh', {
      sonarToken: 'sqp_token-a.1',
    })

    expect(result.status).toBe(0)
    expect(result.curlStdin).toContain('Authorization: Bearer sqp_token-a.1')
    expect(result.scannerToken).toBe('sqp_token-a.1')
    expect(result.log).not.toContain('sqp_token-a.1')
  })

  it('未设 SONAR_TOKEN 时回退到 PLOTWEAVE_SONAR_TOKEN（如 ~/.zshrc 导出的值），扫描器与 API 调用同源', () => {
    const result = runGate('scripts/sonar-quality-gate.sh', {
      plotweaveSonarToken: 'sqp_fallback~1',
    })

    expect(result.status).toBe(0)
    expect(result.curlStdin).toContain('Authorization: Bearer sqp_fallback~1')
    expect(result.scannerToken).toBe('sqp_fallback~1')
  })

  it('SONAR_TOKEN 与 PLOTWEAVE_SONAR_TOKEN 同设时 SONAR_TOKEN 优先', () => {
    const result = runGate('scripts/sonar-quality-gate.sh', {
      sonarToken: 'sqp_primary',
      plotweaveSonarToken: 'sqp_fallback',
    })

    expect(result.status).toBe(0)
    expect(result.curlStdin).toContain('Authorization: Bearer sqp_primary')
    expect(result.curlStdin).not.toContain('sqp_fallback')
    expect(result.scannerToken).toBe('sqp_primary')
  })

  it('未设任何令牌时扫描器与 API 调用均无认证', () => {
    const result = runGate('scripts/sonar-quality-gate.sh')

    expect(result.status).toBe(0)
    expect(result.scannerToken).toBe('')
    expect(result.curlStdin).not.toContain('Authorization')
  })

  it('回退令牌含不支持字符时阻止操作', () => {
    const result = runGate('scripts/sonar-quality-gate.sh', {
      plotweaveSonarToken: 'sqp_bad/token',
    })

    expect(result.status).not.toBe(0)
    expect(`${result.stdout}${result.stderr}`).toContain('不支持的字符')
  })
})

it('统一门禁执行检查与覆盖率时不向被分析代码下发 Sonar 令牌（issue #462）', () => {
  const result = runGate('scripts/sonar-quality-gate.sh', {
    sonarToken: 'test_primary',
    plotweaveSonarToken: 'test_fallback',
  })
  expect(result.status).toBe(0)
  expect(result.log).not.toContain('npm-token-present')
  expect(result.log).not.toContain('rust-token-present')
  expect(result.scannerToken).toBe('test_primary')
  expect(result.curlStdin).toContain('Authorization: Bearer test_primary')
})

it.each(['primary', 'fallback'] as const)(
  '继承已导出的 sonar_token 时仍隔离 %s 凭据（评审 4162846722）',
  (selection) => {
    vi.stubEnv('sonar_token', 'test_inherited_export')
    const result = runGate('scripts/sonar-quality-gate.sh', {
      ...(selection === 'primary' ? { sonarToken: 'test_primary' } : {}),
      plotweaveSonarToken: 'test_fallback',
    })
    const expectedToken =
      selection === 'primary' ? 'test_primary' : 'test_fallback'
    expect(result.status).toBe(0)
    expect(result.log).not.toContain('npm-token-present')
    expect(result.log).not.toContain('rust-token-present')
    expect(result.scannerToken).toBe(expectedToken)
    expect(result.curlStdin).toContain(`Authorization: Bearer ${expectedToken}`)
  },
)

describe('门禁锁恢复命令（issue #430）', { timeout: 30_000 }, () => {
  it.each(['sonar-gate.lock', "sonar lock's $(touch injected).lock"])(
    '锁 %s 被占用时保留原锁，恢复命令只删除该空目录',
    (lockName) => {
      const paths = prepareGatePaths({ lockName, lockOccupied: true })
      const sentinel = resolve(dirname(paths.lockPath), 'keep.txt')
      writeFileSync(sentinel, 'keep')
      const result = runPreparedGate('scripts/sonar-quality-gate.sh', paths)

      expect(result.status).not.toBe(0)
      expect(result.lockExists).toBe(true)
      expect(result.log).toBe('')
      expect(result.pending).toBe('')
      expect(existsSync(paths.coveragePath)).toBe(false)
      expect(result.stderr).toContain(paths.lockPath)
      const cleared = spawnSync('sh', ['-c', recoveryCommand(result)], {
        cwd: dirname(paths.lockPath),
        encoding: 'utf8',
      })
      expect(cleared.status, cleared.stderr).toBe(0)
      expect(existsSync(paths.lockPath)).toBe(false)
      expect(existsSync(resolve(dirname(paths.lockPath), 'injected'))).toBe(
        false,
      )
      expect(readFileSync(sentinel, 'utf8')).toBe('keep')
    },
  )

  it('锁被占用时说明运行中的推送门禁会持有锁数分钟并建议等待（issue #465）', () => {
    const result = runGate('scripts/sonar-quality-gate.sh', {
      lockOccupied: true,
    })

    expect(result.status).not.toBe(0)
    // Stable diagnostic contract: quality-gate-lifecycle.md（issue #465）.
    expect(result.stderr).toContain('[SONAR_GATE_LOCK_WAIT_FOR_RUNNING_GATE]')
  })

  it.each([0, 2])('扫描退出码 %i 时释放本次门禁锁', (scannerExit) => {
    const result = runGate('scripts/sonar-quality-gate.sh', { scannerExit })
    expect(result.status).toBe(scannerExit)
    expect(result.lockExists).toBe(false)
  })
})

describe('强杀门禁后的人工恢复（issue #430）', { timeout: 30_000 }, () => {
  it('活跃门禁与强杀残留锁均拒绝第二次进入，清理后重试完整门禁', async () => {
    const paths = prepareGatePaths()
    writeExecutable(
      paths.npmPath,
      "printf 'TEST_GATE_LOCK_HELD\\n'; while :; do sleep 1; done",
    )
    const child = spawn(
      'sh',
      [resolve(repositoryRoot, 'scripts/sonar-quality-gate.sh')],
      {
        cwd: repositoryRoot,
        detached: true,
        env: gateEnvironment(paths, {}),
      },
    )
    try {
      await waitForHeldGate(child)
      expect(existsSync(paths.lockPath)).toBe(true)
      const active = runPreparedGate('scripts/sonar-quality-gate.sh', paths)
      expect(active.status).not.toBe(0)
      expect(active.log).toBe('')
      expect(active.lockExists).toBe(true)
      await killTestGateGroup(child)
      expect(child.signalCode).toBe('SIGKILL')

      const stale = runPreparedGate('scripts/sonar-quality-gate.sh', paths)
      expect(stale.status).not.toBe(0)
      expect(stale.log).toBe('')
      expect(stale.lockExists).toBe(true)
      const cleared = spawnSync('sh', ['-c', recoveryCommand(stale)], {
        cwd: repositoryRoot,
      })
      expect(cleared.status).toBe(0)
      expect(existsSync(paths.lockPath)).toBe(false)
      writeNpmStub(paths)
      const retried = runPreparedGate('scripts/sonar-quality-gate.sh', paths)
      expect(retried.status).toBe(0)
      expect(retried.lockExists).toBe(false)
      expect(
        retried.log
          .split('\n')
          .filter(Boolean)
          .map((line) => line.split(' ')[0]),
      ).toEqual([
        'npm',
        'npm',
        'npm',
        'npm',
        'cargo-llvm-cov',
        'sonar-scanner',
        'curl',
        'curl',
      ])
      expect(JSON.parse(retried.pending).qualityGate).toBe('OK')
    } finally {
      await killTestGateGroup(child)
    }
  })
})

// pre-push 的门禁分派与按 ref 行为见 scripts/pre-push-refs.test.ts（issue
// #405：钩子读取 stdin，空 stdin 不再触发门禁）；此处只覆盖 pre-commit
// 的接线与失败透传。
describe('.githooks/pre-commit', () => {
  it('执行同一个增量清零门禁并透传失败状态', () => {
    const result = runGate('.githooks/pre-commit', { unresolvedIssues: 1 })

    expect(result.status).not.toBe(0)
    expect(result.log).toContain('npm run test:coverage')
    expect(`${result.stdout}${result.stderr}`).toContain('1')
  })
})

describe('门禁测试标记隔离（issue #428）', { timeout: 30_000 }, () => {
  it.each([
    ['pre-commit', 0],
    ['pre-merge-commit', 0],
    ['pre-commit', 1],
    ['pre-merge-commit', 1],
  ] as const)(
    '%s 在新增未解决问题数为 %i 时只使用本次沙箱的标记路径',
    (hook, unresolvedIssues) => {
      const host = mkdtempSync(resolve(tmpdir(), 'plotweave-host-marker-'))
      temporaryDirectories.push(host)
      const hostMarker = resolve(host, 'gate-tree.marker')
      writeFileSync(hostMarker, 'existing host marker\n')
      vi.stubEnv('PLOTWEAVE_GATE_MARKER_PATH', hostMarker)

      const result = runGate(`.githooks/${hook}`, { unresolvedIssues })

      expect(readFileSync(hostMarker, 'utf8')).toBe('existing host marker\n')
      if (unresolvedIssues === 0) {
        expect(result.status).toBe(0)
        expect(result.marker).toMatch(/^[0-9a-f]{40}\n\d+\n\d+:.+\n$/)
      } else {
        expect(result.status).not.toBe(0)
        expect(result.marker).toBe('')
      }
    },
  )
})

describe(
  '门禁结论摘要记录（issue #355：完整通过后写入待物化文件，推送时并入版本化凭据）',
  { timeout: 30_000 },
  () => {
    it('完整通过后向待物化文件追加一行合法 JSON，且绝不直接触碰版本化文件（PR #415 评审 5338815626）', () => {
      const result = runGate('scripts/sonar-quality-gate.sh')

      expect(result.status).toBe(0)
      const lines = result.pending.split('\n').filter(Boolean)
      expect(lines).toHaveLength(1)
      const record = JSON.parse(lines[0] ?? '')
      expect(record.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/)
      expect(record.tree).toMatch(/^[0-9a-f]{40}$/)
      expect(record.head).toMatch(/^[0-9a-f]{40}$/)
      expect(record.qualityGate).toBe('OK')
      expect(record.newCodeUnresolvedIssues).toBe(0)
      expect(record.frontendLineCoveragePercent).toBe(100)
      expect(record.rustLineCoveragePercent).toBe(100)
      // 门禁运行只写 .git 内待物化文件：提交创建路径不得给被跟踪的
      // 版本化文件留下未暂存改动（否则重放/检出/合并会被打断）
      expect(result.history).toBe('')
    })

    it('行覆盖率按本次 LCOV 的 DA 命中统计（9/10 覆盖 → 90，高于下限不阻断）', () => {
      const result = runGate('scripts/sonar-quality-gate.sh', {
        coverageMode: 'partial',
        rustCoverageMode: 'partial',
      })

      expect(result.status).toBe(0)
      const [line] = result.pending.split('\n').filter(Boolean)
      const record = JSON.parse(line ?? '')
      expect(record.frontendLineCoveragePercent).toBe(90)
      expect(record.rustLineCoveragePercent).toBe(90)
    })

    it('门禁任一环节失败时不追加记录——记录只描述完整通过的运行', () => {
      const failureOptions: GateOptions[] = [
        { formatExit: 1 },
        { scannerExit: 2 },
        { qualityGateStatus: 'ERROR' },
        { unresolvedIssues: 3 },
      ]
      for (const options of failureOptions) {
        const result = runGate('scripts/sonar-quality-gate.sh', options)

        expect(result.status, JSON.stringify(options)).not.toBe(0)
        expect(result.pending, JSON.stringify(options)).toBe('')
      }
    })

    it('追加而非覆盖：既有待物化行保留，新记录续在其后', () => {
      const seed =
        '{"timestamp":"2026-01-01T00:00:00Z","tree":"seed-tree","head":"seed-head",' +
        '"qualityGate":"OK","newCodeUnresolvedIssues":0,' +
        '"frontendLineCoveragePercent":1,"rustLineCoveragePercent":1}'
      const result = runGate('scripts/sonar-quality-gate.sh', {
        pendingSeed: seed,
      })

      expect(result.status).toBe(0)
      const lines = result.pending.split('\n').filter(Boolean)
      expect(lines).toHaveLength(2)
      expect(JSON.parse(lines[0] ?? '')).toEqual(JSON.parse(seed))
      expect(JSON.parse(lines[1] ?? '').qualityGate).toBe('OK')
    })

    it('待物化文件不可写（目录占位，root 下亦然）只警告、不阻塞已通过的门禁', () => {
      const result = runGate('scripts/sonar-quality-gate.sh', {
        pendingBlocked: true,
      })

      expect(result.status).toBe(0)
      expect(result.pending).toBe('')
      expect(`${result.stdout}${result.stderr}`).toContain('无法写入门禁记录')
    })

    it('记录不携带令牌：摘要只入结论，凭据不入库', () => {
      const result = runGate('scripts/sonar-quality-gate.sh', {
        sonarToken: 'sqp_token-a.1',
      })

      expect(result.status).toBe(0)
      expect(result.pending).not.toContain('sqp_token-a.1')
    })

    it('pre-commit 完整通过只写待物化文件：不物化、不弄脏版本化文件', () => {
      const result = runGate('.githooks/pre-commit')

      expect(result.status).toBe(0)
      expect(result.pending.split('\n').filter(Boolean)).toHaveLength(1)
      expect(result.history).toBe('')
    })

    // pre-push 侧「门禁通过后物化」由 scripts/gate-tree-marker.test.ts 的
    // 真实推送 e2e 与 scripts/pre-push-refs.test.ts 的快路径用例覆盖（issue
    // #405 起 pre-push 读取 stdin，空 stdin 不触发门禁）
  },
)
