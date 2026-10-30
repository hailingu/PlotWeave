/** pre-push 逐 ref 分派测试共享的场景沙箱工厂（自 pre-push-refs.test.ts
 * 提取，issue #805）：真实钩子与门禁脚本复制进沙箱并提交为被跟踪内容，
 * 外部命令（npm / cargo-llvm-cov / sonar-scanner / curl / xcodebuild）
 * 使用记录并受控返回的替身。快路径以「无 npm ci 调用」识别，慢路径以
 * 「恰一次 npm ci + 临时 worktree 事后清理」识别；门禁次数以探针或
 * sonar-scanner 替身日志行计。池与沙箱登记由调用方在 afterAll /
 * afterEach 中经 disposePushScenarioFixtures / removePushScenarioSandboxes
 * 清理。 */
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import {
  gitFixtureEnvironment,
  gitScenarioFixture,
} from './git-scenario-fixture'
import { writeGateRoutingProbe } from './gate-routing-probe'
import {
  writeNativeCoverageSource,
  writeXccovStub,
} from './native-coverage-fixture'

const repositoryRoot = resolve(import.meta.dirname, '..')
/** 本模块持有的待清理沙箱副本；removePushScenarioSandboxes 逐例删除。 */
const temporarySandboxes: string[] = []
/** 路由矩阵只观察门禁边界；跨完整流水线的用例显式选择真实门禁。 */
const scenarioRepositories = pushScenarioRepositoryPool(false)
const fullScenarioRepositories = pushScenarioRepositoryPool(true)

/** 创建一个仅记录调用并返回受控结果的外部命令替身。 */
export function writeExecutable(path: string, body: string): void {
  writeFileSync(path, `#!/bin/sh\n${body}\n`)
  chmodSync(path, 0o755)
}

/** pre-push 场景沙箱的能力面：真实 git 与钩子 + 替身命令的观测入口。 */
export interface PushScenario {
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

/** preparePushScenario 的场景选项：fullGate 选择真实完整门禁（默认以
 * gate-routing-probe 替换门禁边界），其余见函数注释。 */
export interface PushScenarioOptions {
  fullGate?: boolean
  gitHookLocalization?: boolean
  qualityGateStatus?: string
  withRemote?: boolean
}

/** 逐例清理 preparePushScenario 登记的沙箱副本（afterEach 调用）。 */
export function removePushScenarioSandboxes(): void {
  for (const directory of temporarySandboxes.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
}

/** 终局清理：先清沙箱副本，再释放两个播种池的模板与副本（afterAll 调用）。 */
export function disposePushScenarioFixtures(): void {
  removePushScenarioSandboxes()
  scenarioRepositories.dispose()
  fullScenarioRepositories.dispose()
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
  writeNativeCoverageSource(sandbox)
  mkdirSync(resolve(sandbox, 'bin'), { recursive: true })
  mkdirSync(resolve(sandbox, 'scripts'), { recursive: true })
  mkdirSync(resolve(sandbox, '.githooks'), { recursive: true })
  for (const script of [
    'check-docs.sh',
    'check-file-size.ts',
    'check-static.sh',
    'file-size-baseline.json',
    'gate-history.sh',
    'gate-scope-core.ts',
    'gate-scope.ts',
    'gate-tree-marker.sh',
    'pre-push-install.mjs',
    'pre-push-install-launcher.mjs',
    'pre-push-install-watchdog.mjs',
    'rust-coverage.sh',
    'sonar-quality-gate.sh',
    'test-native.sh',
    'native-coverage.ts',
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
  // #941：旧路由矩阵只观察原门禁边界；ub-mode 的真实对象/失败检查由
  // ub-mode-gate.test.ts 单独集成验证，不能将此沙箱替身当真实技能执行。
  writeFileSync(
    resolve(sandbox, 'scripts/ub-mode-gate.ts'),
    'process.exitCode = 0\n',
  )
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
      '/native/macos/build/',
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
  writeXccovStub(resolve(bin, 'xcrun'))
  writeExecutable(
    resolve(bin, 'xcodebuild'),
    String.raw`printf 'xcodebuild %s\n' "$*" >> "$PLOTWEAVE_TEST_LOG"
exit "$PLOTWEAVE_TEST_XCODEBUILD_EXIT"`,
  )
  writeExecutable(
    resolve(bin, 'npm'),
    String.raw`printf 'npm %s\n' "$*" >> "$PLOTWEAVE_TEST_LOG"
case "$*" in
  # 门禁下发 CPU 预算（--maxWorkers N），按前缀匹配分发
  "run test:coverage"*)
    printf '%s\n' 'TN:' 'SF:src/example.ts' 'DA:1,1' 'end_of_record' > "$PLOTWEAVE_COVERAGE_REPORT_PATH"
    ;;
esac`,
  )
  writeExecutable(
    resolve(bin, 'cargo-llvm-cov'),
    String.raw`printf 'cargo-llvm-cov %s\n' "$*" >> "$PLOTWEAVE_TEST_LOG"
while [ "$#" -gt 0 ]; do
  if [ "$1" = '--output-path' ]; then output=$2; break; fi
  shift
done
printf '%s\n' 'TN:' 'SF:src-tauri/src/example.rs' 'DA:1,1' 'end_of_record' > "$output"`,
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
    PLOTWEAVE_XCODEBUILD_BIN: resolve(bin, 'xcodebuild'),
    PLOTWEAVE_XCRUN_BIN: resolve(bin, 'xcrun'),
    PLOTWEAVE_NATIVE_MIN_LINE_COVERAGE: '',
    GITHUB_STEP_SUMMARY: resolve(
      sandbox,
      'native/macos/build/coverage/step-summary.md',
    ),
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
    PLOTWEAVE_TEST_XCODEBUILD_EXIT: '0',
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

/** 播种一次、逐例复制的场景仓库池（探针门禁与真实门禁各一）。 */
function pushScenarioRepositoryPool(fullGate: boolean) {
  return gitScenarioFixture((root) => {
    initScratchRepository(root)
    commitScenarioTooling(root, fullGate)
    seedHistory(root)
  })
}

/** 安装真实 pre-push 钩子与门禁脚本（沙箱内为被跟踪副本）并接线替身；
 * 默认创建裸远端 origin（真实 git push 触发钩子）。gitHookLocalization
 * 模拟 git 向提交类钩子导出的工作树定位环境（GIT_INDEX_FILE 等按 cwd
 * 相对解析），验证慢路径子进程对其免疫。 */
export function preparePushScenario(
  options?: PushScenarioOptions,
): PushScenario {
  const sandbox = (
    options?.fullGate ? fullScenarioRepositories : scenarioRepositories
  ).create()
  temporarySandboxes.push(sandbox)

  const logPath = resolve(sandbox, 'calls.log')
  const bin = resolve(sandbox, 'bin')
  mkdirSync(resolve(sandbox, 'coverage'))
  mkdirSync(resolve(sandbox, '.scannerwork'))
  mkdirSync(resolve(sandbox, 'native/macos/build/coverage'), {
    recursive: true,
  })
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
