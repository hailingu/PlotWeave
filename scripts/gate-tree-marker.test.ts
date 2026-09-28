import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'

const repositoryRoot = resolve(import.meta.dirname, '..')
const temporaryDirectories: string[] = []

/** 创建一个仅记录调用并返回受控结果的外部命令替身。 */
function writeExecutable(path: string, body: string): void {
  writeFileSync(path, `#!/bin/sh\n${body}\n`)
  chmodSync(path, 0o755)
}

/** 在沙箱内初始化一个 git 仓库并返回其根目录。 */
function initScratchRepository(sandbox: string): void {
  const git = (args: string[]): void => {
    const result = spawnSync('git', args, { cwd: sandbox, encoding: 'utf8' })
    if (result.status !== 0) {
      throw new Error(`git ${args.join(' ')} 失败：${result.stderr}`)
    }
  }
  git(['init', '-q', '-b', 'main'])
  git(['config', 'user.email', 'gate@test'])
  git(['config', 'user.name', 'gate-test'])
}

/** e2e 场景沙箱：真实钩子 + 真实门禁脚本 + 记录并受控返回的替身命令。
 * 门禁调用次数以 sonar-scanner 替身的日志行计（每次完整门禁恰一次）。 */
interface HookScenario {
  readonly git: (args: string[]) => { status: number | null; stderr: string }
  readonly root: string
  readonly scannerRuns: () => number
}

/** 播种基线历史（钩子未接线，不产生门禁调用）：main 两笔提交，side
 * 自 HEAD~1 增加新文件（供 cherry-pick / merge / squash），topic 自
 * HEAD~1 增加两笔提交（供 rebase 重放），最后回到 main。 */
function seedHistory(sandbox: string): void {
  const seed = (file: string, content: string, message: string): void => {
    writeFileSync(resolve(sandbox, file), `${content}\n`)
    for (const args of [
      ['add', '.'],
      ['commit', '-q', '-m', message],
    ] as const) {
      const result = spawnSync('git', [...args], { cwd: sandbox })
      if (result.status !== 0) {
        throw new Error(`播种提交失败：${message}`)
      }
    }
  }
  seed('f.txt', 'one', 'one')
  seed('f.txt', 'one\ntwo', 'two')
  const branch = (name: string): void => {
    const result = spawnSync('git', ['checkout', '-q', '-b', name, 'HEAD~1'], {
      cwd: sandbox,
    })
    if (result.status !== 0) {
      throw new Error(`播种分支失败：${name}`)
    }
  }
  branch('side')
  seed('g.txt', 'sidec', 'sidec')
  spawnSync('git', ['checkout', '-q', 'main'], { cwd: sandbox })
  branch('topic')
  seed('t1.txt', '1', 't1')
  seed('t2.txt', '2', 't2')
  spawnSync('git', ['checkout', '-q', 'main'], { cwd: sandbox })
}

/** 复制真实钩子与门禁脚本进沙箱（门禁在沙箱根运行），返回替身目录。 */
function copyScenarioFiles(sandbox: string): string {
  const bin = resolve(sandbox, 'bin')
  mkdirSync(bin, { recursive: true })
  mkdirSync(resolve(sandbox, 'scripts'), { recursive: true })
  mkdirSync(resolve(sandbox, '.githooks'), { recursive: true })
  for (const script of [
    'check-static.sh',
    'gate-tree-marker.sh',
    'rust-coverage.sh',
    'sonar-quality-gate.sh',
  ]) {
    copyFileSync(
      resolve(repositoryRoot, 'scripts', script),
      resolve(sandbox, 'scripts', script),
    )
  }
  for (const hook of ['pre-commit', 'pre-merge-commit', 'prepare-commit-msg']) {
    copyFileSync(
      resolve(repositoryRoot, '.githooks', hook),
      resolve(sandbox, '.githooks', hook),
    )
  }
  return bin
}

/** 安装记录并受控返回的外部命令替身（npm / cargo-llvm-cov / 扫描器 /
 * curl），门禁调用次数以 sonar-scanner 替身日志行计。 */
function writeScenarioStubs(bin: string): void {
  writeExecutable(
    resolve(bin, 'npm'),
    String.raw`printf 'npm %s\n' "$*" >> "$PLOTWEAVE_TEST_LOG"
if [ "$*" = "run test:coverage" ]; then
  mkdir -p "$(dirname "$PLOTWEAVE_COVERAGE_REPORT_PATH")"
  printf '%s\n' 'TN:' 'SF:src/example.ts' 'DA:1,1' 'end_of_record' > "$PLOTWEAVE_COVERAGE_REPORT_PATH"
fi`,
  )
  writeExecutable(
    resolve(bin, 'cargo-llvm-cov'),
    String.raw`printf 'cargo-llvm-cov %s\n' "$*" >> "$PLOTWEAVE_TEST_LOG"
printf '%s\n' 'TN:' 'SF:src-tauri/src/example.rs' 'DA:1,1' 'end_of_record' > "$PLOTWEAVE_RUST_COVERAGE_REPORT_PATH"`,
  )
  writeExecutable(
    resolve(bin, 'sonar-scanner'),
    String.raw`printf 'sonar-scanner\n' >> "$PLOTWEAVE_TEST_LOG"
mkdir -p "$(dirname "$PLOTWEAVE_SONAR_REPORT_PATH")"
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
    printf '{"total":0}'
    ;;
  *)
    exit 64
    ;;
esac`,
  )
}

/** 场景环境：替身路径 + 标记与日志覆盖；令牌不继承宿主环境。 */
function scenarioEnvironment(
  sandbox: string,
  bin: string,
  logPath: string,
  qualityGateStatus: string,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PLOTWEAVE_CARGO_LLVM_COV_BIN: resolve(bin, 'cargo-llvm-cov'),
    PLOTWEAVE_CURL_BIN: resolve(bin, 'curl'),
    PLOTWEAVE_COVERAGE_REPORT_PATH: resolve(sandbox, 'coverage', 'lcov.info'),
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
    SONAR_HOST_URL: 'http://sonar.test',
  }
  delete env.SONAR_TOKEN
  delete env.PLOTWEAVE_SONAR_TOKEN
  return env
}

/** 安装真实钩子与门禁脚本（复制进沙箱，门禁在沙箱根运行）并接线替身。 */
function prepareHookScenario(qualityGateStatus = 'OK'): HookScenario {
  const sandbox = mkdtempSync(resolve(tmpdir(), 'plotweave-gate-hooks-'))
  temporaryDirectories.push(sandbox)
  initScratchRepository(sandbox)
  seedHistory(sandbox)

  const logPath = resolve(sandbox, 'calls.log')
  const bin = copyScenarioFiles(sandbox)
  writeScenarioStubs(bin)
  const env = scenarioEnvironment(sandbox, bin, logPath, qualityGateStatus)

  const wire = spawnSync(
    'git',
    ['config', 'core.hooksPath', resolve(sandbox, '.githooks')],
    { cwd: sandbox },
  )
  if (wire.status !== 0) {
    throw new Error('接线 core.hooksPath 失败')
  }

  const git = (args: string[]) =>
    spawnSync('git', args, { cwd: sandbox, encoding: 'utf8', env })
  const scannerRuns = (): number => {
    try {
      return readFileSync(logPath, { encoding: 'utf8' })
        .split('\n')
        .filter((line) => line === 'sonar-scanner').length
    } catch {
      return 0
    }
  }
  return { git, root: sandbox, scannerRuns }
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

// 用例逐个 spawnSync 真实钩子与门禁脚本（多级 shell/git 替身），全量套件
// 并发负载下常超 vitest 默认 5s——与 sonar-quality-gate.test.ts 同款放宽
// describe 级超时上限，不放宽断言。
describe(
  '门禁树标记（issue #404：同一提交操作内去重，无前置门禁路径由此触发）',
  { timeout: 30_000 },
  () => {
    it('write 后同树 check 通过（跳过门禁），换树 check 失败（执行门禁）', () => {
      const sandbox = mkdtempSync(resolve(tmpdir(), 'plotweave-gate-marker-'))
      temporaryDirectories.push(sandbox)
      initScratchRepository(sandbox)
      const markerPath = resolve(sandbox, 'gate-tree.marker')
      const helper = resolve(repositoryRoot, 'scripts', 'gate-tree-marker.sh')
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        PLOTWEAVE_GATE_MARKER_PATH: markerPath,
      }
      const write = spawnSync('sh', [helper, 'write'], {
        cwd: sandbox,
        encoding: 'utf8',
        env,
      })
      expect(write.status).toBe(0)
      expect(
        spawnSync('sh', [helper, 'check'], { cwd: sandbox, env }).status,
      ).toBe(0)
      // 单次消费（评审 4120128545）：命中的标记即删除，同树第二次 check
      // 判为需门禁
      expect(
        spawnSync('sh', [helper, 'check'], { cwd: sandbox, env }).status,
      ).toBe(1)

      writeFileSync(resolve(sandbox, 'f.txt'), 'changed\n')
      spawnSync('git', ['add', '.'], { cwd: sandbox })
      expect(
        spawnSync('sh', [helper, 'check'], { cwd: sandbox, env }).status,
      ).toBe(1)
    })

    it('标记缺失、过期（TTL=0）或内容损坏时 check 失败（执行门禁）', () => {
      const sandbox = mkdtempSync(resolve(tmpdir(), 'plotweave-gate-marker-'))
      temporaryDirectories.push(sandbox)
      initScratchRepository(sandbox)
      const markerPath = resolve(sandbox, 'gate-tree.marker')
      const helper = resolve(repositoryRoot, 'scripts', 'gate-tree-marker.sh')
      const run = (argument: string, ttl?: string) =>
        spawnSync('sh', [helper, argument], {
          cwd: sandbox,
          env: {
            ...process.env,
            PLOTWEAVE_GATE_MARKER_PATH: markerPath,
            ...(ttl === undefined ? {} : { PLOTWEAVE_GATE_MARKER_TTL: ttl }),
          },
        })

      expect(run('check').status).toBe(1)
      expect(run('write').status).toBe(0)
      // 回拨标记时间戳至 epoch 1：超出默认时效（600s）即过期，需重新门禁
      const [tree] = readFileSync(markerPath, 'utf8').split('\n')
      writeFileSync(markerPath, `${tree}\n1\n`)
      expect(run('check').status).toBe(1)

      writeFileSync(markerPath, 'not-a-tree\nnot-a-number\n')
      expect(run('check').status).toBe(1)
    })

    it('标记路径不可写时 write 静默失败，不阻塞门禁已通过的操作（评审 4120128565）', () => {
      const sandbox = mkdtempSync(resolve(tmpdir(), 'plotweave-gate-marker-'))
      temporaryDirectories.push(sandbox)
      initScratchRepository(sandbox)
      // 路径被目录占据：标记重定向必然失败，write 仍须以 0 退出
      const markerPath = resolve(sandbox, 'marker-as-directory')
      mkdirSync(markerPath)
      const write = spawnSync(
        'sh',
        [resolve(repositoryRoot, 'scripts', 'gate-tree-marker.sh'), 'write'],
        {
          cwd: sandbox,
          env: {
            ...process.env,
            PLOTWEAVE_GATE_MARKER_PATH: markerPath,
          },
        },
      )
      expect(write.status).toBe(0)
    })
  },
)

describe(
  '产生提交的命令与门禁钩子（issue #404 探针自动化：每次操作恰一次完整门禁）',
  { timeout: 30_000 },
  () => {
    it('git commit：pre-commit 执行门禁，prepare-commit-msg 经标记去重（合计 1 次）', () => {
      const scenario = prepareHookScenario()
      const result = scenario.git(['commit', '--allow-empty', '-m', 'x'])
      expect(result.status).toBe(0)
      expect(scenario.scannerRuns()).toBe(1)
    })

    it('git revert：无前置门禁钩子，prepare-commit-msg 执行完整门禁（1 次）', () => {
      const scenario = prepareHookScenario()
      const result = scenario.git(['revert', '--no-edit', 'HEAD'])
      expect(result.status).toBe(0)
      expect(scenario.scannerRuns()).toBe(1)
    })

    it('git cherry-pick：prepare-commit-msg 执行完整门禁（1 次）', () => {
      const scenario = prepareHookScenario()
      const result = scenario.git(['cherry-pick', 'side'])
      expect(result.status).toBe(0)
      expect(scenario.scannerRuns()).toBe(1)
    })

    it('git merge --no-ff：pre-merge-commit 执行门禁，prepare-commit-msg 去重（合计 1 次）', () => {
      const scenario = prepareHookScenario()
      const result = scenario.git(['merge', '--no-ff', 'side', '-m', 'm'])
      expect(result.status).toBe(0)
      expect(scenario.scannerRuns()).toBe(1)
    })

    it('git merge --squash + git commit：仅 pre-commit 一次门禁', () => {
      const scenario = prepareHookScenario()
      expect(scenario.git(['merge', '--squash', 'side']).status).toBe(0)
      const result = scenario.git(['commit', '-m', 'squashed'])
      expect(result.status).toBe(0)
      expect(scenario.scannerRuns()).toBe(1)
    })

    it('git commit --no-verify：pre-commit 被跳过但 prepare-commit-msg 仍执行门禁（1 次）', () => {
      const scenario = prepareHookScenario()
      const result = scenario.git([
        'commit',
        '--allow-empty',
        '--no-verify',
        '-m',
        'x',
      ])
      expect(result.status).toBe(0)
      expect(scenario.scannerRuns()).toBe(1)
    })

    it('标记单次消费：过检提交后的同树 --no-verify 提交不得复用标记（评审 4120128545）', () => {
      const scenario = prepareHookScenario()
      const first = scenario.git(['commit', '--allow-empty', '-m', 'x'])
      expect(first.status).toBe(0)
      // 首笔提交消费了自己写入的标记：紧随的同树（空提交）--no-verify
      // 提交找不到可复用标记，prepare-commit-msg 执行完整门禁
      const second = scenario.git([
        'commit',
        '--allow-empty',
        '--no-verify',
        '-m',
        'y',
      ])
      expect(second.status).toBe(0)
      expect(scenario.scannerRuns()).toBe(2)
    })

    it('门禁失败（Quality Gate 非 OK）时 revert 被阻止且不产生提交', () => {
      const scenario = prepareHookScenario('ERROR')
      const before = scenario.git(['rev-list', '--count', 'HEAD'])
      const result = scenario.git(['revert', '--no-edit', 'HEAD'])
      expect(result.status).not.toBe(0)
      const after = scenario.git(['rev-list', '--count', 'HEAD'])
      expect(after.stdout.trim()).toBe(before.stdout.trim())
    })

    it('git rebase 重放两个提交：每个重放提交各一次完整门禁（合计 2 次）', () => {
      const scenario = prepareHookScenario()
      const result = scenario.git(['rebase', 'main', 'topic'])
      expect(result.status).toBe(0)
      expect(scenario.scannerRuns()).toBe(2)
    })
  },
)
