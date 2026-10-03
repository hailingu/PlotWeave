import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { resolve } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import {
  gitFixtureEnvironment,
  gitScenarioFixture,
} from './git-scenario-fixture'
import { writeGateRoutingProbe } from './gate-routing-probe'

const repositoryRoot = resolve(import.meta.dirname, '..')
const temporaryDirectories: string[] = []
const zeroSha = '0000000000000000000000000000000000000000'
/** 路由矩阵只观察门禁边界；跨完整流水线的用例显式选择真实门禁。 */
function repositoryFixture(fullGate: boolean) {
  return gitScenarioFixture((root) => {
    initScratchRepository(root)
    commitScenarioTooling(root, fullGate)
    seedHistory(root)
  })
}
const repositories = repositoryFixture(false)
const fullRepositories = repositoryFixture(true)

afterAll(() => {
  repositories.dispose()
  fullRepositories.dispose()
})

/** 在被推分支安装零依赖 lifecycle 探针；只记录令牌是否存在，不记录值。 */
function commitInstallProbe(scenario: PushScenario, body: string): string {
  const probePath = resolve(scenario.root, 'bin', 'install-probe.json')
  scenario.env.PLOTWEAVE_TEST_INSTALL_PROBE = probePath
  scenario.env.PLOTWEAVE_TEST_NPM_CLI = resolve(
    process.execPath,
    '../../lib/node_modules/npm/bin/npm-cli.js',
  )
  expect(scenario.git(['checkout', '-q', 'side']).status).toBe(0)
  const manifest = {
    name: 'install-probe',
    version: '1.0.0',
    scripts: { prepare: 'node lifecycle.cjs' },
  }
  writeFileSync(
    resolve(scenario.root, 'package.json'),
    JSON.stringify(manifest),
  )
  writeFileSync(
    resolve(scenario.root, 'package-lock.json'),
    JSON.stringify({
      name: 'install-probe',
      version: '1.0.0',
      lockfileVersion: 3,
      packages: { '': { name: 'install-probe', version: '1.0.0' } },
    }),
  )
  writeFileSync(
    resolve(scenario.root, '.npmrc'),
    'audit=false\nfund=false\nregistry=https://registry.invalid\n',
  )
  writeFileSync(resolve(scenario.root, 'lifecycle.cjs'), body)
  expect(
    scenario.git([
      'add',
      '--',
      'package.json',
      'package-lock.json',
      '.npmrc',
      'lifecycle.cjs',
    ]).status,
  ).toBe(0)
  // 此提交仅播种安装输入；真正被测的 push 仍使用真实钩子与完整门禁。
  expect(
    scenario.git([
      '-c',
      'core.hooksPath=/dev/null',
      'commit',
      '-q',
      '-m',
      'install probe',
    ]).status,
  ).toBe(0)
  expect(scenario.git(['checkout', '-q', 'main']).status).toBe(0)
  const npmPath = resolve(scenario.root, 'bin', 'npm')
  const original = readFileSync(npmPath, 'utf8')
  writeExecutable(
    npmPath,
    String.raw`if [ "$*" = ci ]; then
  exec "$PLOTWEAVE_NODE_BIN" "$PLOTWEAVE_TEST_NPM_CLI" ci
fi
${original}`,
  )
  writeFileSync(resolve(scenario.root, 'calls.log'), '')
  return probePath
}

/** 在真实 lifecycle 就绪后触发期限回调，避免用 1 秒预算压缩 npm 启动。
 * 只替换安装监督器的默认期限计时；真实进程、期限处理器与 KILL 升级仍执行。 */
function triggerInstallDeadlineWhenReady(scenario: PushScenario): void {
  const clock = resolve(scenario.root, 'bin', 'install-clock.cjs')
  writeFileSync(
    clock,
    String.raw`
if (process.argv[1]?.endsWith('/pre-push-install.mjs')) {
  const { existsSync } = require('node:fs')
  const realSetTimeout = global.setTimeout
  global.setTimeout = (callback, delay, ...args) => {
    if (delay !== 300_000) return realSetTimeout(callback, delay, ...args)
    const started = Date.now()
    const timer = realSetTimeout(() => {
      const ready = existsSync(process.env.PLOTWEAVE_TEST_INSTALL_PROBE)
      if (!ready && Date.now() - started < 20_000) return timer.refresh()
      if (!ready) console.error('[TEST_INSTALL_NOT_READY] lifecycle 未就绪')
      callback(...args)
    }, 20)
    return timer
  }
}
`,
  )
  const node = resolve(scenario.root, 'bin', 'controlled-node')
  writeExecutable(
    node,
    'exec "$PLOTWEAVE_REAL_NODE_BIN" --require "$PLOTWEAVE_TEST_INSTALL_CLOCK" "$@"',
  )
  scenario.env.PLOTWEAVE_REAL_NODE_BIN = process.execPath
  scenario.env.PLOTWEAVE_TEST_INSTALL_CLOCK = clock
  scenario.env.PLOTWEAVE_NODE_BIN = node
  scenario.env.PLOTWEAVE_NPM_INSTALL_TIMEOUT = '300'
}

/** 创建一个仅记录调用并返回受控结果的外部命令替身。 */
function writeExecutable(path: string, body: string): void {
  writeFileSync(path, `#!/bin/sh\n${body}\n`)
  chmodSync(path, 0o755)
}

/** 在沙箱内初始化一个 git 仓库并返回其根目录。 */
function initScratchRepository(sandbox: string): void {
  const git = (args: string[]): void => {
    const result = spawnSync('git', args, {
      cwd: sandbox,
      encoding: 'utf8',
      env: gitFixtureEnvironment(),
    })
    if (result.status !== 0) {
      throw new Error(`git ${args.join(' ')} 失败：${result.stderr}`)
    }
  }
  git(['init', '-q', '-b', 'main'])
  git(['config', 'core.hooksPath', '/dev/null'])
  git(['config', 'user.email', 'pushgate@test'])
  git(['config', 'user.name', 'push-gate-test'])
}

/** pre-push 按 ref 分派场景沙箱：真实钩子与门禁脚本（复制进沙箱并提交，
 * 使其成为被跟踪内容而非未跟踪降级因素）+ 记录并受控返回的替身命令。
 * 快路径以「无 npm ci 调用」识别，慢路径以「恰一次 npm ci + 临时
 * worktree 事后清理」识别；门禁次数以探针或 sonar-scanner 替身日志行计。 */
interface PushScenario {
  readonly env: NodeJS.ProcessEnv
  readonly git: (args: string[]) => { status: number | null; stderr: string }
  readonly historyPath: string
  readonly pendingPath: string
  readonly root: string
  readonly runHookWithStdin: (stdin: string) => {
    status: number | null
    stderr: string
    stdout: string
  }
  readonly gateRuns: () => number
  readonly installRuns: () => number
  readonly worktreeCount: () => number
  readonly headSha: () => string
  readonly sideSha: () => string
}

/** 播种基线历史（钩子未接线，不产生门禁调用）：main 两笔提交，side 自
 * HEAD~1 增加新文件，最后回到 main——推送 side 即推送非检出分支。 */
function seedHistory(sandbox: string): void {
  const seed = (file: string, content: string, message: string): void => {
    writeFileSync(resolve(sandbox, file), `${content}\n`)
    for (const args of [
      ['add', '.'],
      ['commit', '-q', '-m', message],
    ] as const) {
      const result = spawnSync('git', [...args], {
        cwd: sandbox,
        env: gitFixtureEnvironment(),
      })
      if (result.status !== 0) {
        throw new Error(`播种提交失败：${message}`)
      }
    }
  }
  seed('f.txt', 'one', 'one')
  seed('f.txt', 'one\ntwo', 'two')
  const branch = spawnSync('git', ['checkout', '-q', '-b', 'side', 'HEAD~1'], {
    cwd: sandbox,
    env: gitFixtureEnvironment(),
  })
  if (branch.status !== 0) {
    throw new Error('播种分支失败：side')
  }
  seed('g.txt', 'sidec', 'sidec')
  const back = spawnSync('git', ['checkout', '-q', 'main'], {
    cwd: sandbox,
    env: gitFixtureEnvironment(),
  })
  if (back.status !== 0) {
    throw new Error('切回 main 失败')
  }
}

/** 复制真实钩子与门禁脚本进沙箱并提交为被跟踪内容（沙箱内的门禁工具
 * 属于被推状态，不得构成快路径的未跟踪降级因素）。 */
function commitScenarioTooling(sandbox: string, fullGate: boolean): void {
  mkdirSync(resolve(sandbox, 'bin'), { recursive: true })
  mkdirSync(resolve(sandbox, 'scripts'), { recursive: true })
  mkdirSync(resolve(sandbox, '.githooks'), { recursive: true })
  for (const script of [
    'check-file-size.ts',
    'check-rust-module-graph-guard.sh',
    'check-static.sh',
    'file-size-baseline.json',
    'gate-history.sh',
    'gate-tree-marker.sh',
    'pre-push-install.mjs',
    'rust-coverage.sh',
    'sonar-quality-gate.sh',
  ]) {
    copyFileSync(
      resolve(repositoryRoot, 'scripts', script),
      resolve(sandbox, 'scripts', script),
    )
  }
  for (const hook of [
    'pre-commit',
    'pre-merge-commit',
    'prepare-commit-msg',
    'pre-push',
  ]) {
    copyFileSync(
      resolve(repositoryRoot, '.githooks', hook),
      resolve(sandbox, '.githooks', hook),
    )
  }
  if (!fullGate) {
    writeGateRoutingProbe(resolve(sandbox, 'scripts/sonar-quality-gate.sh'))
  }
  // 沙箱产物走根层文件（calls.log 等）：提交沙箱级 .gitignore，使快路径
  // 的未跟踪检查在产物存在时仍可成立（--exclude-standard 生效的实证）
  writeFileSync(
    resolve(sandbox, '.gitignore'),
    [
      'calls.log',
      'gate-pending.jsonl',
      'gate-tree.marker',
      'gate-history.jsonl',
      '/bin/',
      '/coverage/',
      '/rust-coverage/',
      '/.scannerwork/',
      '/origin.git/',
      '',
    ].join('\n'),
  )
  const commit = spawnSync('git', ['add', '.', '-A'], {
    cwd: sandbox,
    env: gitFixtureEnvironment(),
  })
  if (commit.status !== 0) {
    throw new Error('暂存沙箱工具失败')
  }
  const tooling = spawnSync('git', ['commit', '-q', '-m', 'tooling'], {
    cwd: sandbox,
    env: gitFixtureEnvironment(),
  })
  if (tooling.status !== 0) {
    throw new Error('提交沙箱工具失败')
  }
}

/** 安装记录并受控返回的外部命令替身（npm / cargo-llvm-cov / 扫描器 /
 * curl），门禁次数以 sonar-scanner 日志行计、依赖安装以 npm ci 计。 */
function writeScenarioStubs(bin: string): void {
  writeExecutable(
    resolve(bin, 'npm'),
    String.raw`printf 'npm %s\n' "$*" >> "$PLOTWEAVE_TEST_LOG"
if [ "$*" = "run test:coverage" ]; then
  printf '%s\n' 'TN:' 'SF:src/example.ts' 'DA:1,1' 'end_of_record' > "$PLOTWEAVE_COVERAGE_REPORT_PATH"
fi`,
  )
  writeExecutable(
    resolve(bin, 'cargo-llvm-cov'),
    String.raw`printf 'cargo-llvm-cov %s\n' "$*" >> "$PLOTWEAVE_TEST_LOG"
printf '%s\n' 'TN:' 'SF:src-tauri/src/example.rs' 'DA:1,1' 'end_of_record' > "$PLOTWEAVE_RUST_COVERAGE_REPORT_PATH"`,
  )
  // cargo 替身（issue #471 元守卫）：门禁的 check-rust-module-graph-guard.sh
  // 经 PLOTWEAVE_CARGO_BIN 调用 cargo 枚举——输出高于存活下限 90 的受控
  // module_graph:: 用例清单。
  writeExecutable(
    resolve(bin, 'cargo'),
    String.raw`printf 'cargo %s\n' "$*" >> "$PLOTWEAVE_TEST_LOG"
i=0
while [ "$i" -lt 95 ]; do
  printf 'module_graph::case_%s: test\n' "$i"
  i=$((i + 1))
done`,
  )
  writeExecutable(
    resolve(bin, 'sonar-scanner'),
    String.raw`printf 'sonar-scanner\n' >> "$PLOTWEAVE_TEST_LOG"
printf 'analyzed-tree %s\n' "$(git write-tree)" >> "$PLOTWEAVE_TEST_LOG"
printf 'untracked-input %s\n' "$(git ls-files --others --exclude-standard tests fixtures docs)" >> "$PLOTWEAVE_TEST_LOG"
printf '%s\n' 'projectKey=PlotWeave' 'serverUrl=http://sonar.test' > "$PLOTWEAVE_SONAR_REPORT_PATH"`,
  )
  writeExecutable(
    resolve(bin, 'curl'),
    String.raw`cat > /dev/null
case "$*" in
  *qualitygates/project_status*)
    printf '{"projectStatus":{"status":"%s"}}' "$PLOTWEAVE_TEST_QUALITY_GATE_STATUS"
    ;;
  *api/issues/search*)
    printf '{"total":%s}' "$PLOTWEAVE_TEST_UNRESOLVED_ISSUES"
    ;;
  *)
    exit 64
    ;;
esac`,
  )
}

/** 场景环境：替身路径 + 记录与日志覆盖；令牌不继承宿主环境。 */
function scenarioEnvironment(
  sandbox: string,
  bin: string,
  logPath: string,
  qualityGateStatus: string,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...gitFixtureEnvironment(),
    // 外层慢路径导出的根属于被推树；本场景的门禁只能读取自己的沙箱。
    PLOTWEAVE_GATE_REPOSITORY_ROOT: sandbox,
    PLOTWEAVE_CARGO_BIN: resolve(bin, 'cargo'),
    PLOTWEAVE_CARGO_LLVM_COV_BIN: resolve(bin, 'cargo-llvm-cov'),
    PLOTWEAVE_CURL_BIN: resolve(bin, 'curl'),
    PLOTWEAVE_COVERAGE_REPORT_PATH: resolve(sandbox, 'coverage', 'lcov.info'),
    PLOTWEAVE_GATE_HISTORY_PATH: resolve(sandbox, 'gate-history.jsonl'),
    PLOTWEAVE_GATE_PENDING_PATH: resolve(sandbox, 'gate-pending.jsonl'),
    PLOTWEAVE_RUST_COVERAGE_REPORT_PATH: resolve(
      sandbox,
      'rust-coverage',
      'lcov-rust.info',
    ),
    PLOTWEAVE_SONAR_LOCK_DIRECTORY: resolve(sandbox, 'sonar-gate.lock'),
    PLOTWEAVE_NODE_BIN: process.execPath,
    PLOTWEAVE_NPM_BIN: resolve(bin, 'npm'),
    PLOTWEAVE_SONAR_REPORT_PATH: resolve(
      sandbox,
      '.scannerwork',
      'report-task.txt',
    ),
    PLOTWEAVE_SONAR_SCANNER_BIN: resolve(bin, 'sonar-scanner'),
    PLOTWEAVE_GATE_MARKER_PATH: resolve(sandbox, 'gate-tree.marker'),
    PLOTWEAVE_TEST_LOG: logPath,
    PLOTWEAVE_TEST_QUALITY_GATE_STATUS: qualityGateStatus,
    PLOTWEAVE_TEST_UNRESOLVED_ISSUES: '0',
    SONAR_HOST_URL: 'http://sonar.test',
  }
  delete env.SONAR_TOKEN
  delete env.PLOTWEAVE_SONAR_TOKEN
  // 推送门禁内运行本套件时亦须能安装并观察替换对象，触发条件不继承禁用。
  delete env.GIT_NO_REPLACE_OBJECTS
  return env
}

/** 在沙箱内创建裸远端并登记为 origin（真实 git push 的推送目标）。 */
function addBareRemote(sandbox: string): void {
  const remote = resolve(sandbox, 'origin.git')
  const init = spawnSync('git', ['init', '--bare', '-q', remote], {
    cwd: sandbox,
    env: gitFixtureEnvironment(),
  })
  const add = spawnSync('git', ['remote', 'add', 'origin', remote], {
    cwd: sandbox,
    env: gitFixtureEnvironment(),
  })
  if (init.status !== 0 || add.status !== 0) {
    throw new Error('创建裸远端失败')
  }
}

/** 安装真实 pre-push 钩子与门禁脚本（沙箱内为被跟踪副本）并接线替身；
 * 默认创建裸远端 origin（真实 git push 触发钩子）。gitHookLocalization
 * 模拟 git 向提交类钩子导出的工作树定位环境（GIT_INDEX_FILE 等按 cwd
 * 相对解析），验证慢路径子进程对其免疫。 */
function preparePushScenario(options?: {
  fullGate?: boolean
  gitHookLocalization?: boolean
  qualityGateStatus?: string
  withRemote?: boolean
}): PushScenario {
  const sandbox = (options?.fullGate ? fullRepositories : repositories).create()
  temporaryDirectories.push(sandbox)

  const logPath = resolve(sandbox, 'calls.log')
  const bin = resolve(sandbox, 'bin')
  mkdirSync(resolve(sandbox, 'coverage'))
  mkdirSync(resolve(sandbox, '.scannerwork'))
  writeScenarioStubs(bin)
  const env = scenarioEnvironment(
    sandbox,
    bin,
    logPath,
    options?.qualityGateStatus ?? 'OK',
  )
  if (options?.gitHookLocalization) {
    env.GIT_INDEX_FILE = '.git/index'
    env.GIT_PREFIX = ''
  }

  const wire = spawnSync('git', ['config', 'core.hooksPath', '.githooks'], {
    cwd: sandbox,
    env: gitFixtureEnvironment(),
  })
  if (wire.status !== 0) {
    throw new Error('接线 core.hooksPath 失败')
  }
  if (options?.withRemote !== false) {
    addBareRemote(sandbox)
  }

  const git = (args: string[]) =>
    spawnSync('git', args, { cwd: sandbox, encoding: 'utf8', env })
  const hookPath = resolve(sandbox, '.githooks', 'pre-push')
  const runHookWithStdin = (stdin: string) =>
    spawnSync('sh', [hookPath], {
      cwd: sandbox,
      encoding: 'utf8',
      env,
      input: stdin,
    })
  const countExactLines = (line: string): number => {
    try {
      return readFileSync(logPath, { encoding: 'utf8' })
        .split('\n')
        .filter((entry) => entry === line).length
    } catch {
      return 0
    }
  }
  const revParse = (revision: string): string =>
    git(['rev-parse', revision]).stdout.trim()
  return {
    env,
    git,
    historyPath: resolve(sandbox, 'gate-history.jsonl'),
    pendingPath: resolve(sandbox, 'gate-pending.jsonl'),
    root: sandbox,
    runHookWithStdin,
    gateRuns: () =>
      countExactLines('sonar-scanner') + countExactLines('gate-probe'),
    installRuns: () => countExactLines('npm ci'),
    worktreeCount: () =>
      git(['worktree', 'list']).stdout.split('\n').filter(Boolean).length,
    headSha: () => revParse('HEAD'),
    sideSha: () => revParse('side'),
  }
}

afterEach(() => {
  vi.unstubAllEnvs()
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

/** 读取版本化记录文件并解析为 JSON 行（文件缺失时为空数组）。 */
function readRecords(path: string): Record<string, unknown>[] {
  try {
    return readFileSync(path, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>)
  } catch {
    return []
  }
}

/** 断言推送链路产生的记录中存在 head 等于指定提交的行——被推提交即
 * 门禁分析对象（issue #405 验收：stdin 待推 ref 与分析对象一致）。 */
function expectRecordedCommit(
  scenario: PushScenario,
  commit: string,
): Record<string, unknown> {
  const records = readRecords(scenario.historyPath).concat(
    readRecords(scenario.pendingPath),
  )
  const match = records.filter((record) => record.head === commit)
  expect(match, `记录中应存在 head=${commit}`).not.toBeNull()
  expect(match.length, `记录 head=${commit} 应恰有一行`).toBeGreaterThan(0)
  return match[0] as Record<string, unknown>
}

/** 对照真实扫描工作目录的索引树与台账，验证分析内容来自原始被推树。 */
function expectOriginalTree(scenario: PushScenario, commit: string): void {
  const originalTree = scenario
    .git(['--no-replace-objects', 'rev-parse', `${commit}^{tree}`])
    .stdout.trim()
  expect(expectRecordedCommit(scenario, commit).tree).toBe(originalTree)
  expect(readFileSync(resolve(scenario.root, 'calls.log'), 'utf8')).toContain(
    `analyzed-tree ${originalTree}\n`,
  )
}

// 用例逐个真实 git push / 直启真实钩子（多级 shell/git 替身），全量套件
// 并发负载下常超 vitest 默认 5s——与 gate-tree-marker.test.ts 同款放宽
// describe 级超时上限，不放宽断言。套件按矩阵维度分组：单个 describe
// 回调保持在新函数 80 计行上限内（AGENTS.md 尺寸上限）。
describe(
  'pre-push 真实安装环境与超时（issue #462）',
  { timeout: 30_000 },
  () => {
    it('真实 npm ci prepare 无 Sonar 令牌，推送仍完整认证并绑定原始树', () => {
      const scenario = preparePushScenario({ fullGate: true })
      const probe = commitInstallProbe(
        scenario,
        String.raw`
const fs = require('node:fs')
fs.writeFileSync(process.env.PLOTWEAVE_TEST_INSTALL_PROBE, JSON.stringify({
  primary: 'SONAR_TOKEN' in process.env,
  fallback: 'PLOTWEAVE_SONAR_TOKEN' in process.env,
}))`,
      )
      scenario.env.SONAR_TOKEN = 'test_primary'
      scenario.env.PLOTWEAVE_SONAR_TOKEN = 'test_fallback'
      const push = scenario.git(['push', 'origin', 'side'])
      expect(push.status, push.stderr).toBe(0)
      expect(JSON.parse(readFileSync(probe, 'utf8'))).toEqual({
        primary: false,
        fallback: false,
      })
      expectOriginalTree(scenario, scenario.sideSha())
      expect(scenario.worktreeCount()).toBe(1)
    })

    it('真实 npm ci 超时阻止推送并终止忽略 TERM 的 lifecycle 子进程', () => {
      const scenario = preparePushScenario({ fullGate: true })
      const probe = commitInstallProbe(
        scenario,
        String.raw`
const { spawn } = require('node:child_process')
process.on('SIGTERM', () => {})
spawn(process.execPath, ['-e', \`
  process.on('SIGTERM', () => {})
  require('node:fs').writeFileSync(process.env.PLOTWEAVE_TEST_INSTALL_PROBE, String(process.pid))
  setInterval(() => {}, 1000)
\`], { stdio: 'inherit' })
setInterval(() => {}, 1000)`.replaceAll('\\`', '`'),
      )
      triggerInstallDeadlineWhenReady(scenario)
      const push = scenario.git(['push', 'origin', 'side'])
      expect(push.status).not.toBe(0)
      // Stable diagnostic contract: quality-gate-push.md, issue #462.
      expect(push.stderr).toContain('[PRE_PUSH_INSTALL_TIMEOUT]')
      const pid = Number(readFileSync(probe, 'utf8'))
      expect(() => process.kill(pid, 0)).toThrow()
      expect(scenario.gateRuns()).toBe(0)
      expect(scenario.worktreeCount()).toBe(1)
      expect(
        scenario.git(['ls-remote', 'origin', 'refs/heads/side']).stdout.trim(),
      ).toBe('')
    })
  },
)

describe('pre-push 安装失败封闭（issue #462）', { timeout: 30_000 }, () => {
  it('安装失败阻止扫描和推送并清理临时树', () => {
    const scenario = preparePushScenario()
    writeExecutable(resolve(scenario.root, 'bin', 'npm'), 'exit 23')
    const push = scenario.git(['push', 'origin', 'side'])
    expect(push.status).not.toBe(0)
    expect(scenario.gateRuns()).toBe(0)
    expect(scenario.worktreeCount()).toBe(1)
    expect(
      scenario.git(['ls-remote', 'origin', 'refs/heads/side']).stdout.trim(),
    ).toBe('')
  })

  it.each(['0', '-1', 'abc', '2147484'])(
    '无效安装期限 %s 拒绝启动安装',
    (timeout) => {
      const scenario = preparePushScenario()
      scenario.env.PLOTWEAVE_NPM_INSTALL_TIMEOUT = timeout
      const push = scenario.git(['push', 'origin', 'side'])
      expect(push.status).not.toBe(0)
      // Stable diagnostic contract: quality-gate-push.md, issue #462.
      expect(push.stderr).toContain('[PRE_PUSH_INSTALL_TIMEOUT_INVALID]')
      expect(scenario.installRuns()).toBe(0)
      expect(scenario.gateRuns()).toBe(0)
      expect(scenario.worktreeCount()).toBe(1)
    },
  )
})

describe(
  'pre-push 测试沙箱根隔离（issue #405 慢路径门禁）',
  { timeout: 30_000 },
  () => {
    it('继承外层门禁根覆盖时，沙箱快路径仍扫描和记录自己的提交', () => {
      vi.stubEnv('PLOTWEAVE_GATE_REPOSITORY_ROOT', repositoryRoot)
      const scenario = preparePushScenario({ fullGate: true })

      const push = scenario.git(['push', 'origin', 'main'])

      expect(push.status).toBe(0)
      expect(scenario.installRuns()).toBe(0)
      expectOriginalTree(scenario, scenario.headSha())
    })
  },
)

it(
  '当前非空基线不阻止推送不含登记路径的历史分支（评审 5379198759）',
  { timeout: 30_000 },
  () => {
    // 真实 pre-push 慢路径必须应用当前额度，而非把当前登记当成历史树清单。
    const scenario = preparePushScenario({ fullGate: true })
    mkdirSync(resolve(scenario.root, 'src'))
    writeFileSync(resolve(scenario.root, 'src/legacy.ts'), '\n'.repeat(900))
    writeFileSync(
      resolve(scenario.root, 'scripts/file-size-baseline.json'),
      JSON.stringify({
        version: 1,
        files: { 'src/legacy.ts': 900 },
      }),
    )
    expect(
      scenario.git([
        'add',
        '--',
        'src/legacy.ts',
        'scripts/file-size-baseline.json',
      ]).status,
    ).toBe(0)
    const pushed = scenario.sideSha()
    const result = scenario.git(['push', 'origin', 'side'])
    expect(result.status, result.stderr).toBe(0)
    expect(scenario.installRuns()).toBe(1)
    expect(scenario.gateRuns()).toBe(1)
    expectOriginalTree(scenario, pushed)
    expect(scenario.worktreeCount()).toBe(1)
  },
)

describe(
  'pre-push 替换对象：分析原始被推提交（PR #442 评审 5361127076）',
  { timeout: 30_000 },
  () => {
    it('非检出提交存在替换引用：扫描与台账保持原始树，远端收到原始 SHA', () => {
      const scenario = preparePushScenario()
      const original = scenario.sideSha()
      expect(scenario.git(['replace', original, 'HEAD']).status).toBe(0)

      const push = scenario.git(['push', 'origin', 'side'])

      expect(push.status).toBe(0)
      expectOriginalTree(scenario, original)
      expect(scenario.worktreeCount()).toBe(1)
      expect(
        scenario.git(['ls-remote', 'origin', 'refs/heads/side']).stdout,
      ).toContain(original)
    })

    it('HEAD 已检出替换内容：降级慢路径并保留本地替换内容', () => {
      const scenario = preparePushScenario()
      const original = scenario.headSha()
      expect(scenario.git(['replace', original, 'side']).status).toBe(0)
      expect(scenario.git(['read-tree', '--reset', '-u', 'HEAD']).status).toBe(
        0,
      )

      const push = scenario.git(['push', 'origin', 'main'])

      expect(push.status).toBe(0)
      expect(scenario.installRuns()).toBe(1)
      expectOriginalTree(scenario, original)
      expect(readFileSync(resolve(scenario.root, 'g.txt'), 'utf8')).toBe(
        'sidec\n',
      )
    })

    it('干净 HEAD 仅有替换引用：仍在原始树执行快路径', () => {
      const scenario = preparePushScenario()
      const original = scenario.headSha()
      expect(scenario.git(['replace', original, 'side']).status).toBe(0)

      const push = scenario.git(['push', 'origin', 'main'])

      expect(push.status).toBe(0)
      expect(scenario.installRuns()).toBe(0)
      expectOriginalTree(scenario, original)
    })
  },
)

describe(
  'pre-push 未跟踪输入：任意目录均隔离（PR #442 评审 5361127076）',
  { timeout: 30_000 },
  () => {
    it.each(['tests/boost.test.ts', 'fixtures/boost.json', 'docs/local.md'])(
      '未跟踪 %s 不参与被推树的门禁且保留本地内容',
      (path) => {
        const scenario = preparePushScenario()
        const file = resolve(scenario.root, path)
        mkdirSync(resolve(file, '..'), { recursive: true })
        writeFileSync(file, 'local input\n')

        const push = scenario.git(['push', 'origin', 'main'])

        expect(push.status).toBe(0)
        expect(scenario.installRuns()).toBe(1)
        expectOriginalTree(scenario, scenario.headSha())
        expect(readFileSync(file, 'utf8')).toBe('local input\n')
        expect(
          readFileSync(resolve(scenario.root, 'calls.log'), 'utf8'),
        ).not.toContain(path)
        expect(scenario.worktreeCount()).toBe(1)
      },
    )
  },
)

describe(
  'pre-push 快路径：被推提交即 HEAD 且可证等价（issue #405）',
  {
    timeout: 30_000,
  },
  () => {
    it('待推 ref 即 HEAD 且工作树可证等价：当前工作树直接执行完整门禁（无依赖安装）', () => {
      const scenario = preparePushScenario()
      const push = scenario.git(['push', 'origin', 'main'])

      expect(push.status).toBe(0)
      expect(scenario.gateRuns()).toBe(1)
      expect(scenario.installRuns()).toBe(0)
      expect(scenario.worktreeCount()).toBe(1)
      expectRecordedCommit(scenario, scenario.headSha())
      expect(readRecords(scenario.historyPath).length).toBeGreaterThanOrEqual(1)
    })

    it('快路径门禁失败仍阻止推送：远端不出现该 ref', () => {
      const scenario = preparePushScenario({
        qualityGateStatus: 'ERROR',
        fullGate: true,
      })
      const push = scenario.git(['push', 'origin', 'main'])

      expect(push.status).not.toBe(0)
      expect(scenario.gateRuns()).toBe(1)
      expect(
        scenario.git(['ls-remote', 'origin', 'refs/heads/main']).stdout.trim(),
      ).toBe('')
    })
  },
)

describe(
  'pre-push 慢路径分派：被推提交非当前工作树可证等价的状态（issue #405）',
  { timeout: 30_000 },
  () => {
    it('推送非检出分支：临时 worktree 检出被推提交执行门禁，分析对象即被推提交（探针自动化）', () => {
      const scenario = preparePushScenario({ fullGate: true })
      const push = scenario.git(['push', 'origin', 'side'])

      expect(push.status).toBe(0)
      expect(scenario.gateRuns()).toBe(1)
      // 慢路径标识：临时 worktree 的依赖安装恰发生一次
      expect(scenario.installRuns()).toBe(1)
      expect(scenario.worktreeCount()).toBe(1)
      expectRecordedCommit(scenario, scenario.sideSha())
      expect(
        scenario.git(['ls-remote', 'origin', 'refs/heads/side']).stdout,
      ).toContain(scenario.sideSha())
    })

    it('脏工作树推送当前分支（复现 2b）：在临时 worktree 分析被推提交，本地差异原样保留', () => {
      const scenario = preparePushScenario({ fullGate: true })
      writeFileSync(resolve(scenario.root, 'f.txt'), 'one\ntwo\ndirty\n')

      const push = scenario.git(['push', 'origin', 'main'])

      expect(push.status).toBe(0)
      expect(scenario.gateRuns()).toBe(1)
      expect(scenario.installRuns()).toBe(1)
      expectRecordedCommit(scenario, scenario.headSha())
      expect(readFileSync(resolve(scenario.root, 'f.txt'), 'utf8')).toContain(
        'dirty',
      )
    })

    it('未跟踪文件落在门禁读取的树（src/）时降级慢路径，不将其并入分析对象', () => {
      const scenario = preparePushScenario()
      mkdirSync(resolve(scenario.root, 'src'))
      writeFileSync(resolve(scenario.root, 'src', 'local.ts'), 'export {}\n')

      const push = scenario.git(['push', 'origin', 'main'])

      expect(push.status).toBe(0)
      expect(scenario.installRuns()).toBe(1)
      expectRecordedCommit(scenario, scenario.headSha())
    })
  },
)

describe(
  'pre-push 慢路径触发原因输出（issue #463）',
  { timeout: 30_000 },
  () => {
    it('快路径可达：不输出任何慢路径触发原因', () => {
      const scenario = preparePushScenario()
      const push = scenario.git(['push', 'origin', 'main'])

      expect(push.status).toBe(0)
      expect(scenario.installRuns()).toBe(0)
      expect(`${push.stdout}${push.stderr}`).not.toContain('PRE_PUSH_SLOW_')
    })

    it('推送非检出分支：输出 PRE_PUSH_SLOW_NOT_HEAD', () => {
      const scenario = preparePushScenario()
      const push = scenario.git(['push', 'origin', 'side'])

      expect(push.status).toBe(0)
      expect(scenario.installRuns()).toBe(1)
      // Stable diagnostic contract: quality-gate-push.md, issue #463.
      expect(`${push.stdout}${push.stderr}`).toContain('PRE_PUSH_SLOW_NOT_HEAD')
    })

    it('工作树被跟踪内容与 HEAD 有差异：输出 PRE_PUSH_SLOW_TRACKED_DIRTY', () => {
      const scenario = preparePushScenario()
      writeFileSync(resolve(scenario.root, 'f.txt'), 'one\ntwo\ndirty\n')

      const push = scenario.git(['push', 'origin', 'main'])

      expect(push.status).toBe(0)
      expect(scenario.installRuns()).toBe(1)
      // Stable diagnostic contract: quality-gate-push.md, issue #463.
      expect(`${push.stdout}${push.stderr}`).toContain(
        'PRE_PUSH_SLOW_TRACKED_DIRTY',
      )
    })

    it('索引内容与 HEAD 有差异（差异只在暂存区）：输出 PRE_PUSH_SLOW_INDEX_DIRTY', () => {
      const scenario = preparePushScenario()
      writeFileSync(resolve(scenario.root, 'f.txt'), 'one\ntwo\nstaged\n')
      expect(scenario.git(['add', '--', 'f.txt']).status).toBe(0)
      // 工作树内容还原为 HEAD 版本，差异只保留在索引
      writeFileSync(
        resolve(scenario.root, 'f.txt'),
        scenario.git(['show', 'HEAD:f.txt']).stdout,
      )

      const push = scenario.git(['push', 'origin', 'main'])

      expect(push.status).toBe(0)
      expect(scenario.installRuns()).toBe(1)
      // Stable diagnostic contract: quality-gate-push.md, issue #463.
      expect(`${push.stdout}${push.stderr}`).toContain(
        'PRE_PUSH_SLOW_INDEX_DIRTY',
      )
    })

    it('未忽略未跟踪文件：输出 PRE_PUSH_SLOW_UNTRACKED_INPUT', () => {
      const scenario = preparePushScenario()
      writeFileSync(resolve(scenario.root, 'draft.md'), 'scratch note\n')

      const push = scenario.git(['push', 'origin', 'main'])

      expect(push.status).toBe(0)
      expect(scenario.installRuns()).toBe(1)
      // Stable diagnostic contract: quality-gate-push.md, issue #463.
      expect(`${push.stdout}${push.stderr}`).toContain(
        'PRE_PUSH_SLOW_UNTRACKED_INPUT',
      )
    })
  },
)

describe(
  'pre-push 慢路径健壮性：失败清理与钩子环境隔离（issue #405）',
  {
    timeout: 30_000,
  },
  () => {
    it('慢路径门禁失败阻止推送并清理临时 worktree', () => {
      const scenario = preparePushScenario({
        qualityGateStatus: 'ERROR',
        fullGate: true,
      })
      const push = scenario.git(['push', 'origin', 'side'])

      expect(push.status).not.toBe(0)
      expect(scenario.gateRuns()).toBe(1)
      expect(scenario.installRuns()).toBe(1)
      expect(scenario.worktreeCount()).toBe(1)
      expect(
        scenario.git(['ls-remote', 'origin', 'refs/heads/side']).stdout.trim(),
      ).toBe('')
    })

    it('提交类钩子导出的 git 定位环境（GIT_INDEX_FILE 等相对 .git/index）不破坏慢路径', () => {
      const scenario = preparePushScenario({
        gitHookLocalization: true,
        fullGate: true,
      })
      const push = scenario.git(['push', 'origin', 'side'])

      expect(push.status).toBe(0)
      expect(scenario.installRuns()).toBe(1)
      expect(scenario.worktreeCount()).toBe(1)
      expectRecordedCommit(scenario, scenario.sideSha())
    })
  },
)

describe(
  'pre-push 多 ref 分派：按唯一提交去重，快慢路径可并存（issue #405）',
  { timeout: 30_000 },
  () => {
    it('一次推多个不同 ref：每个唯一提交各一次门禁调用，快慢路径并存', () => {
      const scenario = preparePushScenario({ fullGate: true })
      const push = scenario.git(['push', 'origin', 'main', 'side'])

      expect(push.status).toBe(0)
      expect(scenario.gateRuns()).toBe(2)
      // side 走慢路径恰一次依赖安装；main 为快路径不安装
      expect(scenario.installRuns()).toBe(1)
      expectRecordedCommit(scenario, scenario.headSha())
      expectRecordedCommit(scenario, scenario.sideSha())
    })

    it('多个 ref 指向同一提交（分支 + 注释标签）只分析一次，标签 peel 到提交', () => {
      const scenario = preparePushScenario()
      expect(
        scenario.git(['tag', '-a', 'v-side', '-m', 't', 'side']).status,
      ).toBe(0)

      const push = scenario.git(['push', 'origin', 'side', 'v-side'])

      expect(push.status).toBe(0)
      expect(scenario.gateRuns()).toBe(1)
      expect(scenario.installRuns()).toBe(1)
      expectRecordedCommit(scenario, scenario.sideSha())
    })
  },
)

describe(
  'pre-push 删除 ref 与空输入：不导出代码即不分析（issue #405）',
  {
    timeout: 30_000,
  },
  () => {
    it('真实删除推送不产生门禁调用：删除不导出代码', () => {
      const scenario = preparePushScenario()
      expect(scenario.git(['push', 'origin', 'side']).status).toBe(0)
      const runsAfterSide = scenario.gateRuns()

      const remove = scenario.git(['push', 'origin', ':side'])

      expect(remove.status).toBe(0)
      expect(scenario.gateRuns()).toBe(runsAfterSide)
      expect(
        scenario.git(['ls-remote', 'origin', 'refs/heads/side']).stdout.trim(),
      ).toBe('')
    })

    it('stdin 无待推 ref：不执行门禁，仍物化待物化行', () => {
      const scenario = preparePushScenario({ withRemote: false })
      const seed =
        '{"timestamp":"2026-01-01T00:00:00Z","tree":"seed-tree","head":"seed-head",' +
        '"qualityGate":"OK","newCodeUnresolvedIssues":0,' +
        '"frontendLineCoveragePercent":1,"rustLineCoveragePercent":1}'
      writeFileSync(scenario.pendingPath, `${seed}\n`)

      const result = scenario.runHookWithStdin('')

      expect(result.status).toBe(0)
      expect(scenario.gateRuns()).toBe(0)
      expect(readRecords(scenario.historyPath)).toHaveLength(1)
      expect(readRecords(scenario.pendingPath)).toHaveLength(0)
    })

    it('仅删除行（本地 sha 全零）不执行门禁', () => {
      const scenario = preparePushScenario({ withRemote: false })
      const result = scenario.runHookWithStdin(
        `(delete) ${zeroSha} refs/heads/side ${scenario.sideSha()}\n`,
      )

      expect(result.status).toBe(0)
      expect(scenario.gateRuns()).toBe(0)
      expect(scenario.installRuns()).toBe(0)
    })
  },
)

describe(
  'pre-push 解析失败 fail-closed：不猜测分析对象（issue #405）',
  {
    timeout: 30_000,
  },
  () => {
    it('畸形 ref 行 fail-closed：非零退出并说明原因', () => {
      const scenario = preparePushScenario({ withRemote: false })
      const result = scenario.runHookWithStdin('not-a-ref-line\n')

      expect(result.status).not.toBe(0)
      expect(`${result.stdout}${result.stderr}`).toContain('待推送')
    })

    it('待推对象无法解析为提交（如树对象）fail-closed：非零退出', () => {
      const scenario = preparePushScenario({ withRemote: false })
      const treeSha = scenario.git(['rev-parse', 'HEAD^{tree}']).stdout.trim()
      const result = scenario.runHookWithStdin(
        `refs/heads/odd ${treeSha} refs/heads/odd ${zeroSha}\n`,
      )

      expect(result.status).not.toBe(0)
      expect(`${result.stdout}${result.stderr}`).toContain('提交')
    })
  },
)

describe(
  'pre-push 清单末行无尾随换行：fail-closed 不静默放行（issue #464）',
  { timeout: 30_000 },
  () => {
    it('单行无尾随换行：非零退出、诊断指明被跳过 ref、不执行门禁', () => {
      const scenario = preparePushScenario({ withRemote: false })
      const result = scenario.runHookWithStdin(
        `refs/heads/main ${scenario.headSha()} refs/heads/main ${zeroSha}`,
      )

      expect(result.status).not.toBe(0)
      expect(`${result.stdout}${result.stderr}`).toContain('待推送')
      expect(`${result.stdout}${result.stderr}`).toContain('refs/heads/main')
      expect(scenario.gateRuns()).toBe(0)
      expect(scenario.installRuns()).toBe(0)
    })

    it('前置正常换行行后仍有未终止末行：整清单拒绝，不因前面行成功而放宽', () => {
      const scenario = preparePushScenario({ withRemote: false })
      const result = scenario.runHookWithStdin(
        `(delete) ${zeroSha} refs/heads/side ${scenario.sideSha()}\n` +
          `refs/heads/main ${scenario.headSha()} refs/heads/main ${zeroSha}`,
      )

      expect(result.status).not.toBe(0)
      expect(`${result.stdout}${result.stderr}`).toContain('refs/heads/main')
      expect(scenario.gateRuns()).toBe(0)
    })

    it('残留末行不含字段（仅空白）：与空白行同口径跳过，不视为待推 ref', () => {
      const scenario = preparePushScenario({ withRemote: false })
      const result = scenario.runHookWithStdin('   ')

      expect(result.status).toBe(0)
      expect(scenario.gateRuns()).toBe(0)
    })
  },
)

/** 读取场景调用日志全文（文件尚未创建时为空串）。 */
function readScenarioLog(scenario: PushScenario): string {
  try {
    return readFileSync(resolve(scenario.root, 'calls.log'), 'utf8')
  } catch {
    return ''
  }
}

/** 读取悬挂扫描器记录的忽略 TERM 后代 pid（未就绪时为 NaN）。 */
function scannerDescendantPid(scenario: PushScenario): number {
  const entry = readScenarioLog(scenario)
    .split('\n')
    .find((line) => line.startsWith('scanner-descendant '))
  return entry ? Number(entry.split(' ')[1]) : Number.NaN
}

/** 探测进程是否仍存活；已退出返回 false，其余信号错误仍抛出。 */
function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ESRCH') {
      return false
    }
    throw error
  }
}

/** 安装悬挂的扫描器替身：登记一个忽略 TERM 的后代后与门禁一起悬挂。 */
function writeHangingScanner(scenario: PushScenario): void {
  writeExecutable(
    resolve(scenario.root, 'bin', 'sonar-scanner'),
    String.raw`printf 'sonar-scanner\n' >> "$PLOTWEAVE_TEST_LOG"
mkdir -p "$(dirname "$PLOTWEAVE_SONAR_REPORT_PATH")"
printf '%s\n' 'projectKey=PlotWeave' 'serverUrl=http://sonar.test' > "$PLOTWEAVE_SONAR_REPORT_PATH"
sh -c 'trap "" TERM; printf "scanner-descendant %s\n" $$ >> "$PLOTWEAVE_TEST_LOG"; exec sleep 45' &
exec sleep 45`,
  )
}

/** 读取悬挂扫描器前台进程记录的 pid（未就绪时为 NaN）。 */
function scannerForegroundPid(scenario: PushScenario): number {
  const entry = readScenarioLog(scenario)
    .split('\n')
    .find((line) => line.startsWith('scanner-foreground '))
  return entry ? Number(entry.split(' ')[1]) : Number.NaN
}

/** 安装前台本体忽略 TERM 的悬挂扫描器：复现评审 5389125859 的场景——
 * 门禁的直接前台子进程越过宽限期不退出，验证锁仍先释放。 */
function writeTermIgnoringForegroundScanner(scenario: PushScenario): void {
  writeExecutable(
    resolve(scenario.root, 'bin', 'sonar-scanner'),
    String.raw`printf 'sonar-scanner\n' >> "$PLOTWEAVE_TEST_LOG"
printf 'scanner-foreground %s\n' $$ >> "$PLOTWEAVE_TEST_LOG"
mkdir -p "$(dirname "$PLOTWEAVE_SONAR_REPORT_PATH")"
printf '%s\n' 'projectKey=PlotWeave' 'serverUrl=http://sonar.test' > "$PLOTWEAVE_SONAR_REPORT_PATH"
trap '' TERM
exec sleep 45`,
  )
}

/** 读取桩门禁组长记录的 pid（未就绪时为 NaN）。 */
function gateLeaderPid(scenario: PushScenario): number {
  const entry = readScenarioLog(scenario)
    .split('\n')
    .find((line) => line.startsWith('gate-leader '))
  return entry ? Number(entry.split(' ')[1]) : Number.NaN
}

/** 用忽略 TERM 的桩门禁替换沙箱工作树中的门禁脚本（统一门禁规则：
 * 慢路径执行当前工作树版本），模拟宽限期内永不退出的受监督组长。 */
function writeStubbornGateLeader(scenario: PushScenario): void {
  writeExecutable(
    resolve(scenario.root, 'scripts', 'sonar-quality-gate.sh'),
    String.raw`mkdir "$PLOTWEAVE_SONAR_LOCK_DIRECTORY"
printf 'gate-leader %s\n' $$ >> "$PLOTWEAVE_TEST_LOG"
trap '' TERM
sleep 45 &
wait`,
  )
}

/** 悬挂钩子被单独中断后的观测结果。 */
interface InterruptOutcome {
  readonly code: number | null
  readonly stderr: string
  readonly watchedPid: number
  readonly tempWorktreePath: string | undefined
}

/** 运行真实钩子至就绪探针给出 pid，随后只向钩子进程本身发信号；
 * 默认在收尾时清理被观察进程，断言「存活」的用例可关闭并自行清理。 */
async function runHookUntilReadyAndInterrupt(
  scenario: PushScenario,
  stdin: string,
  signal: 'SIGINT' | 'SIGTERM',
  readinessPid: (scenario: PushScenario) => number = scannerDescendantPid,
  cleanupWatchedProcess = true,
): Promise<InterruptOutcome> {
  const child = spawn('sh', [resolve(scenario.root, '.githooks', 'pre-push')], {
    cwd: scenario.root,
    env: scenario.env,
  })
  let stderr = ''
  let watchedPid = Number.NaN
  child.stderr.on('data', (data: Buffer) => {
    stderr += data.toString()
  })
  child.stdin.write(stdin)
  child.stdin.end()
  const completion = once(child, 'exit', {
    signal: AbortSignal.timeout(30_000),
  })
  try {
    await expect
      .poll(() => readinessPid(scenario), { timeout: 20_000 })
      .toBeGreaterThan(0)
    watchedPid = readinessPid(scenario)
    const tempWorktreePath = scenario
      .git(['worktree', 'list', '--porcelain'])
      .stdout.split('\n')
      .filter((line) => line.startsWith('worktree '))
      .map((line) => line.slice('worktree '.length))
      .find((path) => path.includes('plotweave-pre-push.'))
    child.kill(signal)
    const [code] = (await completion) as [number | null]
    // 保留运行的组员（组长存活用例）会一直持有 stdout/stderr 管道，
    // close 不可达：以 exit 判定钩子退出，并给已排队的数据事件一个
    // 结算窗口，避免随后的断言读不到退出前的输出。
    await new Promise((resolve) => {
      setTimeout(resolve, 200)
    })
    return { code, stderr, watchedPid, tempWorktreePath }
  } finally {
    child.kill('SIGKILL')
    if (
      cleanupWatchedProcess &&
      Number.isFinite(watchedPid) &&
      processAlive(watchedPid)
    ) {
      process.kill(watchedPid, 'SIGKILL')
    }
    await completion.catch(() => {})
  }
}

/** 断言中断后的公共收敛：子进程组结束、锁释放、无残留误报。 */
async function expectInterruptConverged(
  scenario: PushScenario,
  outcome: InterruptOutcome,
  expectedCode: number,
): Promise<void> {
  expect(outcome.code).toBe(expectedCode)
  // Stable diagnostic contract: quality-gate-push.md, issue #465.
  expect(outcome.stderr).toContain('[PRE_PUSH_INTERRUPTED]')
  expect(outcome.stderr).not.toContain('[PRE_PUSH_WORKTREE_RESIDUE]')
  expect(scenario.worktreeCount()).toBe(1)
  await expect
    .poll(() => processAlive(outcome.watchedPid), { timeout: 10_000 })
    .toBe(false)
  await expect
    .poll(() => existsSync(String(scenario.env.PLOTWEAVE_SONAR_LOCK_DIRECTORY)))
    .toBe(false)
}

describe(
  'pre-push 中断清理：信号及时终止门禁子进程组（issue #465）',
  { timeout: 60_000 },
  () => {
    it('慢路径悬挂时仅向钩子发 SIGINT：秒级退出并移除临时 worktree', async () => {
      const scenario = preparePushScenario({
        withRemote: false,
        fullGate: true,
      })
      writeHangingScanner(scenario)

      const outcome = await runHookUntilReadyAndInterrupt(
        scenario,
        `refs/heads/side ${scenario.sideSha()} refs/heads/side ${zeroSha}\n`,
        'SIGINT',
      )

      expect(outcome.tempWorktreePath).toBeDefined()
      expect(existsSync(outcome.tempWorktreePath ?? '')).toBe(false)
      await expectInterruptConverged(scenario, outcome, 130)
    })

    it('快路径悬挂时仅向钩子发 SIGTERM：秒级退出，无临时树维度', async () => {
      const scenario = preparePushScenario({
        withRemote: false,
        fullGate: true,
      })
      writeHangingScanner(scenario)

      const outcome = await runHookUntilReadyAndInterrupt(
        scenario,
        `refs/heads/main ${scenario.headSha()} refs/heads/main ${zeroSha}\n`,
        'SIGTERM',
      )

      expect(outcome.tempWorktreePath).toBeUndefined()
      await expectInterruptConverged(scenario, outcome, 143)
    })
  },
)

describe(
  'pre-push 中断清理：宽限处理与门禁锁归属（issue #465）',
  { timeout: 60_000 },
  () => {
    it('门禁前台步骤忽略 TERM 超过宽限：门禁仍先释放锁退出，锁不泄漏（PR #484 评审 5389125859）', async () => {
      const scenario = preparePushScenario({
        withRemote: false,
        fullGate: true,
      })
      writeTermIgnoringForegroundScanner(scenario)

      const outcome = await runHookUntilReadyAndInterrupt(
        scenario,
        `refs/heads/side ${scenario.sideSha()} refs/heads/side ${zeroSha}\n`,
        'SIGINT',
        scannerForegroundPid,
      )

      expect(outcome.code).toBe(130)
      // Stable diagnostic contract: quality-gate-push.md, issue #465.
      expect(outcome.stderr).toContain('[PRE_PUSH_INTERRUPTED]')
      expect(outcome.stderr).not.toContain('[PRE_PUSH_LEFTOVER_GROUP]')
      // 评审核心：忽略 TERM 的前台子进程不得使锁在强制终止下泄漏
      await expect
        .poll(() =>
          existsSync(String(scenario.env.PLOTWEAVE_SONAR_LOCK_DIRECTORY)),
        )
        .toBe(false)
      await expect
        .poll(() => processAlive(outcome.watchedPid), { timeout: 10_000 })
        .toBe(false)
      expect(existsSync(outcome.tempWorktreePath ?? '')).toBe(false)
      expect(scenario.worktreeCount()).toBe(1)
    })

    it('受监督组长宽限期内未退出：不对其 KILL，锁保持占用并如实提示（PR #484 评审 5389125859）', async () => {
      const scenario = preparePushScenario({
        withRemote: false,
        fullGate: true,
      })
      writeStubbornGateLeader(scenario)

      const outcome = await runHookUntilReadyAndInterrupt(
        scenario,
        `refs/heads/side ${scenario.sideSha()} refs/heads/side ${zeroSha}\n`,
        'SIGINT',
        gateLeaderPid,
        false,
      )
      try {
        expect(outcome.code).toBe(130)
        // Stable diagnostic contract: quality-gate-push.md（PR #484 评审）。
        expect(outcome.stderr).toContain('[PRE_PUSH_INTERRUPTED]')
        expect(outcome.stderr).toContain('[PRE_PUSH_LEFTOVER_GROUP]')
        // 组长（锁持有者）保留运行，锁目录由其继续持有而非被本钩子清除
        expect(processAlive(outcome.watchedPid)).toBe(true)
        expect(
          existsSync(String(scenario.env.PLOTWEAVE_SONAR_LOCK_DIRECTORY)),
        ).toBe(true)
        expect(scenario.worktreeCount()).toBe(1)
      } finally {
        if (Number.isFinite(outcome.watchedPid)) {
          try {
            process.kill(-outcome.watchedPid, 'SIGKILL')
          } catch {
            // 组长已自行退出，无需清理
          }
        }
        rmSync(String(scenario.env.PLOTWEAVE_SONAR_LOCK_DIRECTORY), {
          recursive: true,
          force: true,
        })
      }
    })
  },
)

/** 在沙箱 bin 首位安装 git 包装器：其余命令透传真实 git；仅
 * `worktree remove` 受控——实际移除后谎报失败，或直接失败不动目录。 */
function wrapScenarioGit(
  scenario: PushScenario,
  removeBehavior: 'removeThenLie' | 'fail',
): void {
  const realGit = spawnSync('sh', ['-c', 'command -v git'], {
    encoding: 'utf8',
  }).stdout.trim()
  scenario.env.PATH = `${resolve(scenario.root, 'bin')}:${scenario.env.PATH}`
  const controlledRemoval =
    removeBehavior === 'removeThenLie'
      ? `"${realGit}" "$@"\n    exit 1`
      : 'exit 1'
  writeExecutable(
    resolve(scenario.root, 'bin', 'git'),
    String.raw`case "$1 $2" in
  'worktree remove')
    ${controlledRemoval}
    ;;
esac
exec "${realGit}" "$@"`,
  )
}

/** 找到并删除慢路径残留在系统临时区的临时根，再修剪 worktree 登记。 */
function pruneLeftoverTempWorktree(scenario: PushScenario): void {
  const tempPath = scenario
    .git(['worktree', 'list', '--porcelain'])
    .stdout.split('\n')
    .filter((line) => line.startsWith('worktree '))
    .map((line) => line.slice('worktree '.length))
    .find((path) => path.includes('plotweave-pre-push.'))
  if (tempPath?.includes('plotweave-pre-push.')) {
    rmSync(resolve(tempPath, '..'), { recursive: true, force: true })
  }
  scenario.git(['worktree', 'prune'])
}

describe('pre-push 清理警告的真实性（issue #465）', { timeout: 30_000 }, () => {
  it('临时 worktree 实际已移除而 remove 报告失败：不输出残留警告', () => {
    const scenario = preparePushScenario({ withRemote: false })
    wrapScenarioGit(scenario, 'removeThenLie')

    const result = scenario.runHookWithStdin(
      `refs/heads/side ${scenario.sideSha()} refs/heads/side ${zeroSha}\n`,
    )

    expect(result.status, result.stderr).toBe(0)
    // Stable diagnostic contract: quality-gate-push.md, issue #465.
    expect(result.stderr).not.toContain('[PRE_PUSH_WORKTREE_RESIDUE]')
    expect(scenario.worktreeCount()).toBe(1)
  })

  it('临时 worktree 确实无法移除：输出一次残留警告代码并保留目录', () => {
    const scenario = preparePushScenario({ withRemote: false })
    wrapScenarioGit(scenario, 'fail')
    try {
      const result = scenario.runHookWithStdin(
        `refs/heads/side ${scenario.sideSha()} refs/heads/side ${zeroSha}\n`,
      )

      expect(result.status, result.stderr).toBe(0)
      // Stable diagnostic contract: quality-gate-push.md, issue #465.
      expect(result.stderr).toContain('[PRE_PUSH_WORKTREE_RESIDUE]')
      expect(
        result.stderr.split('[PRE_PUSH_WORKTREE_RESIDUE]').length - 1,
      ).toBe(1)
      expect(scenario.worktreeCount()).toBe(2)
    } finally {
      pruneLeftoverTempWorktree(scenario)
    }
  })
})
