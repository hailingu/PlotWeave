import {
  appendFileSync,
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { afterEach, describe, expect, it, vi } from 'vitest'

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
 * 门禁调用次数以 sonar-scanner 替身的日志行计（每次完整门禁恰一次）。
 * env 暴露给个别用例按需覆盖（如把版本化记录文件指进仓库内）。 */
interface HookScenario {
  readonly env: NodeJS.ProcessEnv
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
    'check-file-size.ts',
    'file-size-baseline.json',
    'gate-history.sh',
    'gate-tree-marker.sh',
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
    // 外层慢路径导出的根属于被推树；本场景的门禁只能读取自己的沙箱。
    PLOTWEAVE_GATE_REPOSITORY_ROOT: sandbox,
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
  return { env, git, root: sandbox, scannerRuns }
}

afterEach(() => {
  vi.unstubAllEnvs()
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

/** 标记单测场景：临时 git 仓库 + 隔离标记路径，run 以给定参数执行真实
 * 助手（可覆盖标记路径与 TTL）。 */
function prepareMarkerUnit(): {
  markerPath: string
  root: string
  run: (
    argument: string,
    options?: { markerPath?: string; ttl?: string },
  ) => { status: number | null }
} {
  const sandbox = mkdtempSync(resolve(tmpdir(), 'plotweave-gate-marker-'))
  temporaryDirectories.push(sandbox)
  initScratchRepository(sandbox)
  const markerPath = resolve(sandbox, 'gate-tree.marker')
  const helper = resolve(repositoryRoot, 'scripts', 'gate-tree-marker.sh')
  const run = (
    argument: string,
    options?: { markerPath?: string; ttl?: string },
  ) =>
    spawnSync('sh', [helper, argument], {
      cwd: sandbox,
      env: {
        ...process.env,
        PLOTWEAVE_GATE_MARKER_PATH: options?.markerPath ?? markerPath,
        ...(options?.ttl === undefined
          ? {}
          : { PLOTWEAVE_GATE_MARKER_TTL: options.ttl }),
      },
    })
  return { markerPath, root: sandbox, run }
}

// 用例逐个 spawnSync 真实钩子与门禁脚本（多级 shell/git 替身），全量套件
// 并发负载下常超 vitest 默认 5s——与 sonar-quality-gate.test.ts 同款放宽
// describe 级超时上限，不放宽断言。
describe(
  '门禁树标记（issue #404：同一提交操作内去重，无前置门禁路径由此触发）',
  { timeout: 30_000 },
  () => {
    it('write 后同树 check 通过（跳过门禁），换树 check 失败（执行门禁）', () => {
      const { root, run } = prepareMarkerUnit()
      expect(run('write').status).toBe(0)
      expect(run('check').status).toBe(0)
      // 单次消费（评审 4120128545）：命中的标记即删除，同树第二次 check
      // 判为需门禁
      expect(run('check').status).toBe(1)

      writeFileSync(resolve(root, 'f.txt'), 'changed\n')
      spawnSync('git', ['add', '.'], { cwd: root })
      expect(run('check').status).toBe(1)
    })

    it('标记缺失、过期、未来时间戳或内容损坏时 check 失败（执行门禁）', () => {
      const { markerPath, run } = prepareMarkerUnit()
      expect(run('check').status).toBe(1)
      expect(run('write').status).toBe(0)
      // 回拨标记时间戳至 epoch 1：超出默认时效（600s）即过期，需重新门禁
      const [tree] = readFileSync(markerPath, 'utf8').split('\n')
      writeFileSync(markerPath, `${tree}\n1\n`)
      expect(run('check').status).toBe(1)

      // 未来时间戳（时钟回拨后遗留）是异常态：负年龄不得判为新鲜
      // （评审 4120428509），否则整个回拨区间内标记都可被消费
      const future = String(Math.floor(Date.now() / 1000) + 3600)
      writeFileSync(markerPath, `${tree}\n${future}\n`)
      expect(run('check').status).toBe(1)

      writeFileSync(markerPath, 'not-a-tree\nnot-a-number\n')
      expect(run('check').status).toBe(1)
    })

    it('标记路径不可写时 write 静默失败，不阻塞门禁已通过的操作（评审 4120128565）', () => {
      const { root, run } = prepareMarkerUnit()
      // 路径被目录占据：标记重定向必然失败，write 仍须以 0 退出
      const blockedPath = resolve(root, 'marker-as-directory')
      mkdirSync(blockedPath)
      expect(run('write', { markerPath: blockedPath }).status).toBe(0)
    })
  },
)

describe(
  '提交钩子测试沙箱根隔离（issue #405 慢路径门禁）',
  { timeout: 30_000 },
  () => {
    it('继承外层门禁根覆盖时，提交记录仍对应沙箱索引树', () => {
      vi.stubEnv('PLOTWEAVE_GATE_REPOSITORY_ROOT', repositoryRoot)
      const scenario = prepareHookScenario()

      const commit = scenario.git(['commit', '--allow-empty', '-m', 'x'])

      expect(commit.status).toBe(0)
      const record = JSON.parse(
        readFileSync(resolve(scenario.root, 'gate-pending.jsonl'), 'utf8'),
      )
      expect(record.tree).toBe(
        scenario.git(['rev-parse', 'HEAD^{tree}']).stdout.trim(),
      )
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

    it('门禁通过的提交在待物化记录中留下可他验条目：记录树等于提交树，且不物化、不弄脏版本化文件（issue #355）', () => {
      const scenario = prepareHookScenario()
      const result = scenario.git(['commit', '--allow-empty', '-m', 'x'])
      expect(result.status).toBe(0)

      const lines = readFileSync(
        resolve(scenario.root, 'gate-pending.jsonl'),
        'utf8',
      )
        .split('\n')
        .filter(Boolean)
      expect(lines).toHaveLength(1)
      const record = JSON.parse(lines[0] ?? '')
      // 核验路径：读者用 git rev-parse <commit>^{tree} 对照记录的 tree 即可
      // 复核「该提交内容通过过完整门禁」；记录行在推送物化后进入版本化文件
      const commitTree = scenario
        .git(['rev-parse', 'HEAD^{tree}'])
        .stdout.trim()
      expect(record.tree).toBe(commitTree)
      expect(record.head).toMatch(/^[0-9a-f]{40}$/)
      expect(record.qualityGate).toBe('OK')
      expect(record.newCodeUnresolvedIssues).toBe(0)
      // 提交创建路径绝不触碰版本化文件（PR #415 评审 5338815626）
      expect(existsSync(resolve(scenario.root, 'gate-history.jsonl'))).toBe(
        false,
      )
    })

    it('推送门禁通过后物化待物化行到版本化文件并清空（issue #355）', () => {
      const scenario = prepareHookScenario()
      expect(scenario.git(['commit', '--allow-empty', '-m', 'x']).status).toBe(
        0,
      )
      // 裸远端触发 pre-push：门禁后再物化
      const remote = resolve(scenario.root, 'origin.git')
      expect(scenario.git(['init', '--bare', '-q', remote]).status).toBe(0)
      expect(scenario.git(['remote', 'add', 'origin', remote]).status).toBe(0)

      const push = scenario.git(['push', '-u', 'origin', 'main'])
      expect(push.status).toBe(0)
      // 提交一次 + 推送一次，各恰一次完整门禁
      expect(scenario.scannerRuns()).toBe(2)
      const history = readFileSync(
        resolve(scenario.root, 'gate-history.jsonl'),
        'utf8',
      )
        .split('\n')
        .filter(Boolean)
      expect(history).toHaveLength(2)
      for (const line of history) {
        expect(JSON.parse(line).qualityGate).toBe('OK')
      }
      expect(
        readFileSync(resolve(scenario.root, 'gate-pending.jsonl'), 'utf8'),
      ).toBe('')
    })

    it('携带记录行的相邻提交可整体重放：重放不给版本化文件留未暂存改动（PR #415 评审 5338815626）', () => {
      const scenario = prepareHookScenario()
      // 版本化记录文件指进仓库内成为被跟踪文件，模拟机制的常态路径：
      // 后一笔提交携带前一笔的记录行入库
      const trackedHistory = resolve(scenario.root, 'tracked-history.jsonl')
      const git = (args: string[]) =>
        spawnSync('git', args, {
          cwd: scenario.root,
          encoding: 'utf8',
          env: {
            ...scenario.env,
            PLOTWEAVE_GATE_HISTORY_PATH: trackedHistory,
          },
        })
      writeFileSync(trackedHistory, '{"seed":1}\n')
      expect(git(['add', 'tracked-history.jsonl']).status).toBe(0)
      expect(git(['commit', '-m', 'c1']).status).toBe(0)
      appendFileSync(trackedHistory, '{"seed":2}\n')
      expect(git(['add', 'tracked-history.jsonl']).status).toBe(0)
      expect(git(['commit', '-m', 'c2']).status).toBe(0)

      // 重放两笔（--force-rebase 强制重建提交以触发提交创建钩子；onto
      // 为原父提交时 git 会快进复用原提交、不经钩子）：每笔各一次完整
      // 门禁；记录只进待物化文件，重放不得因版本化文件的未暂存改动中止
      const rebase = git(['rebase', '--force-rebase', 'HEAD~2'])
      expect(rebase.status).toBe(0)
      expect(rebase.stderr).not.toContain('would be overwritten')
      expect(scenario.scannerRuns()).toBe(4)
      expect(
        git(['status', '--porcelain', '--', 'tracked-history.jsonl']).stdout,
      ).toBe('')
      expect(
        readFileSync(trackedHistory, 'utf8').split('\n').filter(Boolean),
      ).toEqual(['{"seed":1}', '{"seed":2}'])
    })
  },
)

describe(
  '门禁绕过与失败路径（--no-verify、标记消费、失败阻止、rebase）',
  { timeout: 30_000 },
  () => {
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

    it('回退门禁后不写标记：连续两次同树 --no-verify 提交各执行门禁（评审 4120239723）', () => {
      const scenario = prepareHookScenario()
      // 回退门禁（prepare-commit-msg 直接执行）的同操作内没有标记消费
      // 者：不得写标记，否则第二次同树 --no-verify 提交复用它跳过门禁
      const first = scenario.git([
        'commit',
        '--allow-empty',
        '--no-verify',
        '-m',
        'x',
      ])
      expect(first.status).toBe(0)
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
