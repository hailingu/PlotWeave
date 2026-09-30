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
const zeroSha = '0000000000000000000000000000000000000000'

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
  git(['config', 'user.email', 'pushgate@test'])
  git(['config', 'user.name', 'push-gate-test'])
}

/** pre-push 按 ref 分派场景沙箱：真实钩子与门禁脚本（复制进沙箱并提交，
 * 使其成为被跟踪内容而非未跟踪降级因素）+ 记录并受控返回的替身命令。
 * 快路径以「无 npm ci 调用」识别，慢路径以「恰一次 npm ci + 临时
 * worktree 事后清理」识别；门禁次数以 sonar-scanner 替身日志行计。 */
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
  readonly scannerRuns: () => number
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
      const result = spawnSync('git', [...args], { cwd: sandbox })
      if (result.status !== 0) {
        throw new Error(`播种提交失败：${message}`)
      }
    }
  }
  seed('f.txt', 'one', 'one')
  seed('f.txt', 'one\ntwo', 'two')
  const branch = spawnSync('git', ['checkout', '-q', '-b', 'side', 'HEAD~1'], {
    cwd: sandbox,
  })
  if (branch.status !== 0) {
    throw new Error('播种分支失败：side')
  }
  seed('g.txt', 'sidec', 'sidec')
  const back = spawnSync('git', ['checkout', '-q', 'main'], { cwd: sandbox })
  if (back.status !== 0) {
    throw new Error('切回 main 失败')
  }
}

/** 复制真实钩子与门禁脚本进沙箱并提交为被跟踪内容（沙箱内的门禁工具
 * 属于被推状态，不得构成快路径的未跟踪降级因素）。 */
function commitScenarioTooling(sandbox: string): void {
  mkdirSync(resolve(sandbox, 'bin'), { recursive: true })
  mkdirSync(resolve(sandbox, 'scripts'), { recursive: true })
  mkdirSync(resolve(sandbox, '.githooks'), { recursive: true })
  for (const script of [
    'check-static.sh',
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
  const commit = spawnSync('git', ['add', '.', '-A'], { cwd: sandbox })
  if (commit.status !== 0) {
    throw new Error('暂存沙箱工具失败')
  }
  const tooling = spawnSync('git', ['commit', '-q', '-m', 'tooling'], {
    cwd: sandbox,
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
printf 'analyzed-tree %s\n' "$(git write-tree)" >> "$PLOTWEAVE_TEST_LOG"
printf 'untracked-input %s\n' "$(git ls-files --others --exclude-standard tests fixtures docs)" >> "$PLOTWEAVE_TEST_LOG"
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
    ...process.env,
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
  })
  const add = spawnSync('git', ['remote', 'add', 'origin', remote], {
    cwd: sandbox,
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
  gitHookLocalization?: boolean
  qualityGateStatus?: string
  withRemote?: boolean
}): PushScenario {
  const sandbox = mkdtempSync(resolve(tmpdir(), 'plotweave-push-refs-'))
  temporaryDirectories.push(sandbox)
  initScratchRepository(sandbox)
  commitScenarioTooling(sandbox)
  seedHistory(sandbox)

  const logPath = resolve(sandbox, 'calls.log')
  const bin = resolve(sandbox, 'bin')
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
    scannerRuns: () => countExactLines('sonar-scanner'),
    installRuns: () => countExactLines('npm ci'),
    worktreeCount: () =>
      git(['worktree', 'list']).stdout.split('\n').filter(Boolean).length,
    headSha: () => revParse('HEAD'),
    sideSha: () => revParse('side'),
  }
}

afterEach(() => {
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
      expect(scenario.scannerRuns()).toBe(1)
      expect(scenario.installRuns()).toBe(0)
      expect(scenario.worktreeCount()).toBe(1)
      expectRecordedCommit(scenario, scenario.headSha())
      expect(readRecords(scenario.historyPath).length).toBeGreaterThanOrEqual(1)
    })

    it('快路径门禁失败仍阻止推送：远端不出现该 ref', () => {
      const scenario = preparePushScenario({ qualityGateStatus: 'ERROR' })
      const push = scenario.git(['push', 'origin', 'main'])

      expect(push.status).not.toBe(0)
      expect(scenario.scannerRuns()).toBe(1)
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
      const scenario = preparePushScenario()
      const push = scenario.git(['push', 'origin', 'side'])

      expect(push.status).toBe(0)
      expect(scenario.scannerRuns()).toBe(1)
      // 慢路径标识：临时 worktree 的依赖安装恰发生一次
      expect(scenario.installRuns()).toBe(1)
      expect(scenario.worktreeCount()).toBe(1)
      expectRecordedCommit(scenario, scenario.sideSha())
      expect(
        scenario.git(['ls-remote', 'origin', 'refs/heads/side']).stdout,
      ).toContain(scenario.sideSha())
    })

    it('脏工作树推送当前分支（复现 2b）：在临时 worktree 分析被推提交，本地差异原样保留', () => {
      const scenario = preparePushScenario()
      writeFileSync(resolve(scenario.root, 'f.txt'), 'one\ntwo\ndirty\n')

      const push = scenario.git(['push', 'origin', 'main'])

      expect(push.status).toBe(0)
      expect(scenario.scannerRuns()).toBe(1)
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
  'pre-push 慢路径健壮性：失败清理与钩子环境隔离（issue #405）',
  {
    timeout: 30_000,
  },
  () => {
    it('慢路径门禁失败阻止推送并清理临时 worktree', () => {
      const scenario = preparePushScenario({ qualityGateStatus: 'ERROR' })
      const push = scenario.git(['push', 'origin', 'side'])

      expect(push.status).not.toBe(0)
      expect(scenario.scannerRuns()).toBe(1)
      expect(scenario.installRuns()).toBe(1)
      expect(scenario.worktreeCount()).toBe(1)
      expect(
        scenario.git(['ls-remote', 'origin', 'refs/heads/side']).stdout.trim(),
      ).toBe('')
    })

    it('提交类钩子导出的 git 定位环境（GIT_INDEX_FILE 等相对 .git/index）不破坏慢路径', () => {
      const scenario = preparePushScenario({ gitHookLocalization: true })
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
    it('一次推多个不同 ref：每个唯一提交各一次完整门禁，快慢路径并存', () => {
      const scenario = preparePushScenario()
      const push = scenario.git(['push', 'origin', 'main', 'side'])

      expect(push.status).toBe(0)
      expect(scenario.scannerRuns()).toBe(2)
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
      expect(scenario.scannerRuns()).toBe(1)
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
      const runsAfterSide = scenario.scannerRuns()

      const remove = scenario.git(['push', 'origin', ':side'])

      expect(remove.status).toBe(0)
      expect(scenario.scannerRuns()).toBe(runsAfterSide)
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
      expect(scenario.scannerRuns()).toBe(0)
      expect(readRecords(scenario.historyPath)).toHaveLength(1)
      expect(readRecords(scenario.pendingPath)).toHaveLength(0)
    })

    it('仅删除行（本地 sha 全零）不执行门禁', () => {
      const scenario = preparePushScenario({ withRemote: false })
      const result = scenario.runHookWithStdin(
        `(delete) ${zeroSha} refs/heads/side ${scenario.sideSha()}\n`,
      )

      expect(result.status).toBe(0)
      expect(scenario.scannerRuns()).toBe(0)
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
