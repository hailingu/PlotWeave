import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'

const repositoryRoot = resolve(import.meta.dirname, '..')
const temporaryDirectories: string[] = []

type GateOptions = {
  coverageMode?:
    'empty' | 'malformed' | 'missing' | 'partial' | 'uncovered' | 'valid'
  formatExit?: number
  lintExit?: number
  lockOccupied?: boolean
  npmExit?: number
  pendingReadOnly?: boolean
  pendingSeed?: string
  plotweaveSonarToken?: string
  rustCoverageMode?:
    'empty' | 'malformed' | 'missing' | 'partial' | 'uncovered' | 'valid'
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

/** 在隔离的外部依赖边界下执行真实门禁脚本或 Git hook。 */
/** runGate 的命令替身路径集（sandbox 内固定布局）。 */
interface GateStubPaths {
  readonly logPath: string
  readonly curlStdinPath: string
  readonly scannerTokenPath: string
  readonly coveragePath: string
  readonly rustCoveragePath: string
  readonly historyPath: string
  readonly pendingPath: string
  readonly lockPath: string
  readonly reportPath: string
  readonly npmPath: string
  readonly scannerPath: string
  readonly curlPath: string
  readonly llvmCovPath: string
}

/** 外部命令替身（runGate 拆分，issue #99）：npm / sonar-scanner / curl 的
 * 记录-并-受控返回替身脚本，按选项预置锁与覆盖率形态。 */
function writeCommandStubs(paths: GateStubPaths, options: GateOptions): void {
  writeExecutable(
    paths.npmPath,
    String.raw`printf 'npm %s\n' "$*" >> "$PLOTWEAVE_TEST_LOG"
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
  partial)
    mkdir -p "$(dirname "$PLOTWEAVE_COVERAGE_REPORT_PATH")"
    printf '%s\n' 'TN:' 'SF:src/example.ts' 'DA:1,1' 'DA:2,0' 'DA:3,1' 'end_of_record' > "$PLOTWEAVE_COVERAGE_REPORT_PATH"
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

  if (options.lockOccupied) {
    mkdirSync(paths.lockPath)
  }
  // Rust 覆盖率替身（issue #169）：cargo-llvm-cov 的记录-并-受控返回
  // 替身，按选项预置 LCOV 形态；missing 模式不创建文件（生成缺失）。
  writeExecutable(
    paths.llvmCovPath,
    String.raw`printf 'cargo-llvm-cov %s\n' "$*" >> "$PLOTWEAVE_TEST_LOG"
case "$PLOTWEAVE_TEST_RUST_COVERAGE_MODE" in
  valid)
    printf '%s\n' 'TN:' 'SF:src-tauri/src/example.rs' 'DA:1,1' 'end_of_record' > "$PLOTWEAVE_RUST_COVERAGE_REPORT_PATH"
    ;;
  partial)
    printf '%s\n' 'TN:' 'SF:src-tauri/src/example.rs' 'DA:1,1' 'DA:2,0' 'DA:3,1' 'end_of_record' > "$PLOTWEAVE_RUST_COVERAGE_REPORT_PATH"
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
esac`,
  )
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

function runGate(target: string, options: GateOptions = {}): GateRun {
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
    lockPath: resolve(sandbox, 'sonar-gate.lock'),
    reportPath: resolve(sandbox, '.scannerwork', 'report-task.txt'),
    npmPath: resolve(sandbox, 'bin', 'npm'),
    scannerPath: resolve(sandbox, 'bin', 'sonar-scanner'),
    curlPath: resolve(sandbox, 'bin', 'curl'),
    llvmCovPath: resolve(sandbox, 'bin', 'cargo-llvm-cov'),
  }

  writeCommandStubs(paths, options)

  // 版本化与待物化文件预置为空（待物化可种子/只读）：失败路径不追加时
  // 读到空串；只读形态验证「写不进不阻塞门禁」（issue #355）。版本化
  // 文件保持空串以断言门禁运行绝不直接触碰它（PR #415 评审 5338815626）
  writeFileSync(paths.historyPath, '')
  writeFileSync(paths.pendingPath, '')
  if (options.pendingSeed !== undefined) {
    writeFileSync(paths.pendingPath, `${options.pendingSeed}\n`)
  }
  if (options.pendingReadOnly) {
    chmodSync(paths.pendingPath, 0o444)
  }

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
    pending: readFileSync(paths.pendingPath, { encoding: 'utf8' }),
    scannerToken: readFileSync(paths.scannerTokenPath, {
      encoding: 'utf8',
      flag: 'a+',
    }),
    status: result.status,
    stderr: result.stderr,
    stdout: result.stdout,
  }
}

afterEach(() => {
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

describe.each(['.githooks/pre-commit', '.githooks/pre-push'])(
  '%s',
  (hookPath) => {
    it('执行同一个增量清零门禁并透传失败状态', () => {
      const result = runGate(hookPath, { unresolvedIssues: 1 })

      expect(result.status).not.toBe(0)
      expect(result.log).toContain('npm run test:coverage')
      expect(`${result.stdout}${result.stderr}`).toContain('1')
    })
  },
)

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

    it('行覆盖率按本次 LCOV 的 DA 命中统计（2/3 覆盖 → 66.67）', () => {
      const result = runGate('scripts/sonar-quality-gate.sh', {
        coverageMode: 'partial',
        rustCoverageMode: 'partial',
      })

      expect(result.status).toBe(0)
      const [line] = result.pending.split('\n').filter(Boolean)
      const record = JSON.parse(line ?? '')
      expect(record.frontendLineCoveragePercent).toBe(66.67)
      expect(record.rustLineCoveragePercent).toBe(66.67)
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

    it('待物化文件写入失败只警告、不阻塞已通过的门禁（尽力而为，同树标记哲学）', () => {
      const result = runGate('scripts/sonar-quality-gate.sh', {
        pendingReadOnly: true,
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

    it('pre-push 完整通过后把待物化行物化进版本化文件并清空待物化文件', () => {
      const result = runGate('.githooks/pre-push')

      expect(result.status).toBe(0)
      const lines = result.history.split('\n').filter(Boolean)
      expect(lines).toHaveLength(1)
      expect(JSON.parse(lines[0] ?? '').qualityGate).toBe('OK')
      expect(result.pending).toBe('')
    })
  },
)
