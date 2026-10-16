import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'
import {
  gitFixtureEnvironment,
  gitScenarioFixture,
} from './git-scenario-fixture'

const repositoryRoot = resolve(import.meta.dirname, '..')
const temporaryDirectories: string[] = []

type MaterializeOptions = {
  historyBlocked?: boolean
  /** 后台占锁 N 秒后释放（PR #415 评审 5339243902）：验证物化等待锁。 */
  lockHeldSeconds?: number
  /** 持续占锁（测试自身不释放）：验证等锁超时跳过且不丢待物化行。 */
  lockOccupied?: boolean
  lockTimeout?: string
  pending?: string
}

type MaterializeRun = {
  history: string
  pending: string
  status: number | null
  stderr: string
  stdout: string
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

/** 在隔离路径下执行真实物化脚本（issue #355，PR #415 评审 5338815626）；
 * 锁路径同样隔离到沙箱，并可按选项预置持续/短暂占锁形态（评审
 * 5339243902：物化须持门禁同锁排水）。 */
function runMaterialize(options: MaterializeOptions = {}): MaterializeRun {
  const sandbox = mkdtempSync(resolve(tmpdir(), 'plotweave-gate-history-'))
  temporaryDirectories.push(sandbox)

  const historyPath = resolve(sandbox, 'gate-history.jsonl')
  const pendingPath = resolve(sandbox, 'gate-pending.jsonl')
  const lockPath = resolve(sandbox, 'gate-lock')
  if (options.historyBlocked) {
    // 目录占位使并入无条件失败（root 亦然），替代权限位注入
    mkdirSync(historyPath)
  } else {
    writeFileSync(historyPath, '')
  }
  if (options.pending !== undefined) {
    writeFileSync(pendingPath, options.pending)
  }
  if (options.lockOccupied) {
    mkdirSync(lockPath)
  }
  if (options.lockHeldSeconds !== undefined) {
    spawn(
      'sh',
      [
        '-c',
        `mkdir '${lockPath}' 2>/dev/null || true; sleep ${options.lockHeldSeconds}; rmdir '${lockPath}' 2>/dev/null || true`,
      ],
      { detached: true, stdio: 'ignore' },
    ).unref()
    const deadline = Date.now() + 5000
    while (!existsSync(lockPath) && Date.now() < deadline) {
      // 自旋等待占锁者就位，避免物化先抢到锁使用例失去意义
    }
  }

  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    PLOTWEAVE_GATE_HISTORY_PATH: historyPath,
    PLOTWEAVE_GATE_PENDING_PATH: pendingPath,
    PLOTWEAVE_SONAR_LOCK_DIRECTORY: lockPath,
  }
  if (options.lockTimeout !== undefined) {
    environment.PLOTWEAVE_GATE_MATERIALIZE_LOCK_TIMEOUT = options.lockTimeout
  }
  const result = spawnSync(
    'sh',
    [resolve(repositoryRoot, 'scripts/gate-history.sh'), 'materialize'],
    {
      cwd: repositoryRoot,
      encoding: 'utf8',
      env: environment,
      timeout: 60_000,
    },
  )

  return {
    history: readTextFileBestEffort(historyPath),
    pending: readFileSync(pendingPath, { encoding: 'utf8', flag: 'a+' }),
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

describe(
  '门禁结论物化（gate-history.sh materialize，issue #355）',
  { timeout: 30_000 },
  () => {
    it('把待物化行并入版本化文件并清空待物化文件', () => {
      const result = runMaterialize({
        pending: '{"qualityGate":"OK"}\n{"qualityGate":"OK"}\n',
      })

      expect(result.status).toBe(0)
      expect(result.history.split('\n').filter(Boolean)).toHaveLength(2)
      expect(result.pending).toBe('')
    })

    it('待物化文件缺失或为空时是无操作，版本化文件保持不变', () => {
      for (const pending of [undefined, ''] as const) {
        const result = runMaterialize({ pending })

        expect(result.status, `形态 ${pending ?? 'missing'}`).toBe(0)
        expect(result.history).toBe('')
      }
    })

    it('版本化文件不可写（目录占位，root 下亦然）时只警告、保留待物化行，不阻塞推送', () => {
      const pending = '{"qualityGate":"OK"}\n'
      const result = runMaterialize({ historyBlocked: true, pending })

      expect(result.status).toBe(0)
      expect(result.pending).toBe(pending)
      expect(`${result.stdout}${result.stderr}`).toContain('无法物化')
    })

    it('未知子命令以非零退出并给出用法', () => {
      const sandbox = mkdtempSync(resolve(tmpdir(), 'plotweave-gate-history-'))
      temporaryDirectories.push(sandbox)
      const result = spawnSync(
        'sh',
        [resolve(repositoryRoot, 'scripts/gate-history.sh'), 'nonsense'],
        {
          cwd: repositoryRoot,
          encoding: 'utf8',
          env: {
            ...process.env,
            PLOTWEAVE_GATE_HISTORY_PATH: resolve(sandbox, 'gate-history.jsonl'),
            PLOTWEAVE_GATE_PENDING_PATH: resolve(sandbox, 'gate-pending.jsonl'),
          },
        },
      )

      expect(result.status).toBe(2)
      expect(result.stderr).toContain('用法')
    })

    it('门禁锁被持续占用且等待超时：只警告、待物化行保留（不被清空丢失）、不阻塞推送（PR #415 评审 5339243902）', () => {
      const pending = '{"qualityGate":"OK"}\n'
      const result = runMaterialize({
        lockOccupied: true,
        lockTimeout: '1',
        pending,
      })

      expect(result.status).toBe(0)
      expect(result.pending).toBe(pending)
      expect(`${result.stdout}${result.stderr}`).toContain('等待门禁锁超时')
    })

    it('门禁锁短暂被占后释放：物化等待锁可用后完成排水，并发通过的记录不丢（PR #415 评审 5339243902）', () => {
      const result = runMaterialize({
        lockHeldSeconds: 2,
        lockTimeout: '30',
        pending: '{"qualityGate":"OK"}\n',
      })

      expect(result.status).toBe(0)
      expect(result.history.split('\n').filter(Boolean)).toHaveLength(1)
      expect(result.pending).toBe('')
    })

    it('等待超时配置非数字：警告并跳过物化，不阻塞推送', () => {
      const pending = '{"qualityGate":"OK"}\n'
      const result = runMaterialize({ lockTimeout: 'abc', pending })

      expect(result.status).toBe(0)
      expect(result.pending).toBe(pending)
      expect(`${result.stdout}${result.stderr}`).toContain('非数字')
    })
  },
)

const scenarioFixtures: Array<ReturnType<typeof gitScenarioFixture>> = []

/** 准备独立 Git 仓库并提交种子台账（归因判定需要已跟踪基线）；
 * 返回台账与待物化文件的绝对路径。脚本副本放进 scripts/ 子目录镜像
 * 真实布局（脚本按自身位置推算仓库根）。 */
function prepareIsolatedRepository(historySeed: string): {
  root: string
  historyPath: string
  pendingPath: string
} {
  const fixture = gitScenarioFixture((root) => {
    const environment = gitFixtureEnvironment()
    const run = (args: string[]) =>
      spawnSync('git', args, { cwd: root, encoding: 'utf8', env: environment })
    run(['init', '--initial-branch=main'])
    run(['config', 'user.name', 'Stage'])
    run(['config', 'user.email', 'stage@example.invalid'])
    mkdirSync(resolve(root, 'scripts'), { recursive: true })
    mkdirSync(resolve(root, 'docs/development'), { recursive: true })
    writeFileSync(
      resolve(root, 'docs/development/gate-history.jsonl'),
      historySeed,
    )
    // 目录保留文件：git rm 台账后目录不被修剪，贴合真实仓库形态
    //（评审 5542467935 的复现前提是折并能重建工作树文件）
    writeFileSync(resolve(root, 'docs/development/.keepme'), '')
    run(['add', '-A'])
    run(['commit', '-m', 'base'])
  })
  scenarioFixtures.push(fixture)
  const root = fixture.create()
  return {
    root,
    historyPath: resolve(root, 'docs/development/gate-history.jsonl'),
    pendingPath: resolve(root, 'gate-pending.jsonl'),
  }
}

/** 在准备好的仓库上执行脚本副本的 materialize --stage-for-commit；
 * extraEnv 追加注入（如临时索引场景的 GIT_INDEX_FILE）。 */
function runStageMaterialize(
  root: string,
  historyPath: string,
  pendingPath: string,
  pending: string | undefined,
  extraEnv: NodeJS.ProcessEnv = {},
): { status: number | null; stdout: string; stderr: string } {
  if (pending !== undefined) {
    writeFileSync(pendingPath, pending)
  }
  cpSync(
    resolve(repositoryRoot, 'scripts/gate-history.sh'),
    resolve(root, 'scripts/gate-history.sh'),
  )
  const result = spawnSync(
    'sh',
    [
      resolve(root, 'scripts/gate-history.sh'),
      'materialize',
      '--stage-for-commit',
    ],
    {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...gitFixtureEnvironment(),
        PLOTWEAVE_GATE_HISTORY_PATH: historyPath,
        PLOTWEAVE_GATE_PENDING_PATH: pendingPath,
        PLOTWEAVE_SONAR_LOCK_DIRECTORY: resolve(root, 'gate-lock'),
        ...extraEnv,
      },
      timeout: 60_000,
    },
  )
  return { status: result.status, stdout: result.stdout, stderr: result.stderr }
}

/** 在真实 Git 提交钩子中运行物化，验证 Git 自身选择的索引及最终提交/索引状态。 */
function commitWithMaterialize(
  root: string,
  pendingPath: string,
  args: string[],
) {
  cpSync(
    resolve(repositoryRoot, 'scripts/gate-history.sh'),
    resolve(root, 'scripts/gate-history.sh'),
  )
  const hooksPath = resolve(root, 'commit-hooks')
  mkdirSync(hooksPath, { recursive: true })
  writeFileSync(
    resolve(hooksPath, 'pre-commit'),
    '#!/bin/sh\nexec sh scripts/gate-history.sh materialize --stage-for-commit\n',
    { mode: 0o755 },
  )
  return spawnSync(
    'git',
    ['-c', `core.hooksPath=${hooksPath}`, 'commit', '-m', 'change', ...args],
    {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...gitFixtureEnvironment(),
        PLOTWEAVE_GATE_PENDING_PATH: pendingPath,
        PLOTWEAVE_SONAR_LOCK_DIRECTORY: resolve(root, 'gate-lock'),
      },
      timeout: 60_000,
    },
  )
}

/** 读取仓库内台账的工作树内容与暂存状态（porcelain 首列）。 */
function isolatedLedgerState(root: string): {
  content: string
  stagedModified: boolean
} {
  const content = readFileSync(
    resolve(root, 'docs/development/gate-history.jsonl'),
    'utf8',
  )
  const porcelain = spawnSync(
    'git',
    ['status', '--porcelain', '--', 'docs/development/gate-history.jsonl'],
    { cwd: root, encoding: 'utf8', env: gitFixtureEnvironment() },
  ).stdout
  // 不 trim：porcelain 首列是索引状态，「 M」表示仅工作树改动、未暂存
  return { content, stagedModified: porcelain.startsWith('M') }
}

const seedRecord = JSON.stringify({
  tree: 'a'.repeat(40),
  qualityGate: 'OK',
  newCodeUnresolvedIssues: 0,
})

const secondRecord = JSON.stringify({
  tree: 'b'.repeat(40),
  qualityGate: 'OK',
  newCodeUnresolvedIssues: 0,
})

describe(
  '归因通过的自动暂存：工作树恰为索引内容 + 本次折并的待物化行（PR #581 评审 5537970549）',
  { timeout: 30_000 },
  () => {
    afterEach(() => {
      for (const fixture of scenarioFixtures.splice(0)) fixture.dispose()
    })

    it('待物化行并入后自动暂存进本提交（字节精确匹配）', () => {
      const { root, historyPath, pendingPath } = prepareIsolatedRepository('')
      const result = runStageMaterialize(
        root,
        historyPath,
        pendingPath,
        `${seedRecord}\n`,
      )
      const state = isolatedLedgerState(root)

      expect(result.status).toBe(0)
      expect(state.content.split('\n').filter(Boolean)).toHaveLength(1)
      expect(result.stdout).toContain('已暂存物化记录')
      expect(state.stagedModified).toBe(true)
    })

    it('开发者已暂存自己的台账选择：折并行恰在其上时暂存且选择逐字保留', () => {
      const { root, historyPath, pendingPath } = prepareIsolatedRepository(
        `${seedRecord}\n`,
      )
      writeFileSync(historyPath, `${seedRecord}\n${secondRecord}\n`)
      spawnSync('git', ['add', '--', 'docs/development/gate-history.jsonl'], {
        cwd: root,
        encoding: 'utf8',
        env: gitFixtureEnvironment(),
      })
      const thirdRecord = JSON.stringify({
        tree: 'c'.repeat(40),
        qualityGate: 'OK',
        newCodeUnresolvedIssues: 0,
      })

      const result = runStageMaterialize(
        root,
        historyPath,
        pendingPath,
        `${thirdRecord}\n`,
      )
      const state = isolatedLedgerState(root)

      expect(result.status).toBe(0)
      expect(result.stdout).toContain('已暂存物化记录')
      expect(state.content.split('\n').filter(Boolean)).toEqual([
        seedRecord,
        secondRecord,
        thirdRecord,
      ])
    })
  },
)

describe(
  '无折并时拒绝未归因台账改动（pending 为空，工作树改动不自动暂存）',
  { timeout: 30_000 },
  () => {
    afterEach(() => {
      for (const fixture of scenarioFixtures.splice(0)) fixture.dispose()
    })

    it('人工追加的合法 JSON 行（评审场景：与门禁产物语法不可区分）：不暂存并警告', () => {
      const { root, historyPath, pendingPath } = prepareIsolatedRepository(
        `${seedRecord}\n`,
      )
      appendFileSync(historyPath, `${secondRecord}\n`)

      const result = runStageMaterialize(root, historyPath, pendingPath, '')
      const state = isolatedLedgerState(root)

      expect(result.status).toBe(0)
      expect(state.stagedModified).toBe(false)
      expect(result.stderr).toContain('GATE_HISTORY_UNATTRIBUTED_CHANGE')
    })

    it('修改既有记录行：不暂存并警告', () => {
      const { root, historyPath, pendingPath } = prepareIsolatedRepository(
        `${seedRecord}\n`,
      )
      writeFileSync(historyPath, `${secondRecord}\n`)

      const result = runStageMaterialize(root, historyPath, pendingPath, '')
      const state = isolatedLedgerState(root)

      expect(result.status).toBe(0)
      expect(state.stagedModified).toBe(false)
      expect(result.stderr).toContain('GATE_HISTORY_UNATTRIBUTED_CHANGE')
    })

    it('追加畸形行（如 diff 前缀污染形态）：不暂存并警告', () => {
      const { root, historyPath, pendingPath } = prepareIsolatedRepository(
        `${seedRecord}\n`,
      )
      appendFileSync(historyPath, `+${secondRecord}\n`)

      const result = runStageMaterialize(root, historyPath, pendingPath, '')
      const state = isolatedLedgerState(root)

      expect(result.status).toBe(0)
      expect(state.stagedModified).toBe(false)
      expect(result.stderr).toContain('GATE_HISTORY_UNATTRIBUTED_CHANGE')
    })
  },
)

describe(
  '折并时拒绝额外工作树内容（超出本次折并行的部分不自动暂存）',
  { timeout: 30_000 },
  () => {
    afterEach(() => {
      for (const fixture of scenarioFixtures.splice(0)) fixture.dispose()
    })

    it('工作树在折并行之外多出一行合法 JSON：不暂存并警告', () => {
      const { root, historyPath, pendingPath } = prepareIsolatedRepository(
        `${seedRecord}\n`,
      )
      appendFileSync(historyPath, `${secondRecord}\n`)

      const result = runStageMaterialize(
        root,
        historyPath,
        pendingPath,
        `${secondRecord}\n`,
      )
      const state = isolatedLedgerState(root)

      expect(result.status).toBe(0)
      expect(state.stagedModified).toBe(false)
      expect(result.stderr).toContain('GATE_HISTORY_UNATTRIBUTED_CHANGE')
    })
  },
)

describe(
  '折并时拒绝索引特殊形态（已暂存删除与人工部分暂存，PR #581 评审 5542467935/5542611194）',
  { timeout: 30_000 },
  () => {
    afterEach(() => {
      for (const fixture of scenarioFixtures.splice(0)) fixture.dispose()
    })

    it('已暂存的台账删除：不把折并重建的台账暂存回去，警告 GATE_HISTORY_STAGED_DELETION（PR #581 评审 5542467935）', () => {
      const { root, historyPath, pendingPath } = prepareIsolatedRepository(
        `${seedRecord}\n`,
      )
      spawnSync(
        'git',
        ['rm', '-q', '--', 'docs/development/gate-history.jsonl'],
        { cwd: root, encoding: 'utf8', env: gitFixtureEnvironment() },
      )

      const result = runStageMaterialize(
        root,
        historyPath,
        pendingPath,
        `${secondRecord}\n`,
      )
      const stagedBlob = spawnSync(
        'git',
        ['cat-file', '-e', ':docs/development/gate-history.jsonl'],
        { cwd: root, encoding: 'utf8', env: gitFixtureEnvironment() },
      )

      expect(result.status).toBe(0)
      expect(result.stderr).toContain('GATE_HISTORY_STAGED_DELETION')
      // 删除保留在索引中：git add 未执行，索引里没有台账 blob
      expect(stagedBlob.status).not.toBe(0)
    })

    it('人工部分暂存（索引为 HEAD 之外的中间形态）：不覆盖并警告', () => {
      const { root, historyPath, pendingPath } = prepareIsolatedRepository(
        `${seedRecord}\n`,
      )
      writeFileSync(historyPath, `${seedRecord}\n${secondRecord}\n`)
      spawnSync('git', ['add', '--', 'docs/development/gate-history.jsonl'], {
        cwd: root,
        encoding: 'utf8',
        env: gitFixtureEnvironment(),
      })
      const thirdRecord = JSON.stringify({
        tree: 'd'.repeat(40),
        qualityGate: 'OK',
        newCodeUnresolvedIssues: 0,
      })
      appendFileSync(historyPath, `${thirdRecord}\n`)

      const result = runStageMaterialize(
        root,
        historyPath,
        pendingPath,
        `${thirdRecord}\n`,
      )

      expect(result.status).toBe(0)
      // 部分暂存保持原状：暂存区仍是人工选定的两行，未被整文件覆盖
      expect(result.stderr).toContain('GATE_HISTORY_UNATTRIBUTED_CHANGE')
      const staged = spawnSync(
        'git',
        ['show', ':docs/development/gate-history.jsonl'],
        { cwd: root, encoding: 'utf8', env: gitFixtureEnvironment() },
      ).stdout
      expect(staged.split('\n').filter(Boolean)).toEqual([
        seedRecord,
        secondRecord,
      ])
    })
  },
)

describe(
  '全量提交采纳台账折并（git commit -a / --amend -a，PR #581）',
  { timeout: 30_000 },
  () => {
    afterEach(() => {
      for (const fixture of scenarioFixtures.splice(0)) fixture.dispose()
    })

    it.each([['-a'], ['--amend', '-a']])(
      '%j 将 pending 随本提交入库且不留索引残留',
      (...args) => {
        const { root, historyPath, pendingPath } = prepareIsolatedRepository(
          `${seedRecord}\n`,
        )
        writeFileSync(resolve(root, 'docs/development/.keepme'), 'changed\n')
        writeFileSync(pendingPath, `${secondRecord}\n`)

        const result = commitWithMaterialize(root, pendingPath, args)
        const committed = spawnSync(
          'git',
          ['show', 'HEAD:docs/development/gate-history.jsonl'],
          { cwd: root, encoding: 'utf8', env: gitFixtureEnvironment() },
        )

        expect(result.status, result.stderr).toBe(0)
        expect(committed.status).toBe(0)
        expect(committed.stdout).toBe(`${seedRecord}\n${secondRecord}\n`)
        expect(readFileSync(historyPath, 'utf8')).toBe(committed.stdout)
        expect(readFileSync(pendingPath, 'utf8')).toBe('')
        const state = spawnSync(
          'git',
          [
            'status',
            '--porcelain',
            '--',
            'docs/development/gate-history.jsonl',
          ],
          { cwd: root, encoding: 'utf8', env: gitFixtureEnvironment() },
        )
        expect(state.status).toBe(0)
        expect(state.stdout).toBe('')
      },
    )
  },
)

describe(
  '临时索引下的整体推迟（git commit -- <pathspec> / --only，PR #581 评审 5543397069）',
  { timeout: 30_000 },
  () => {
    afterEach(() => {
      for (const fixture of scenarioFixtures.splice(0)) fixture.dispose()
    })

    it.each([['--'], ['--only']])(
      '%j 提交保留 pending，下一普通提交折并且不留索引残留',
      (...args) => {
        const { root, historyPath, pendingPath } = prepareIsolatedRepository(
          `${seedRecord}\n`,
        )
        writeFileSync(resolve(root, 'docs/development/.keepme'), 'changed\n')
        writeFileSync(pendingPath, `${secondRecord}\n`)

        const result = commitWithMaterialize(root, pendingPath, [
          ...args,
          'docs/development/.keepme',
        ])

        expect(result.status, result.stderr).toBe(0)
        expect(readFileSync(pendingPath, 'utf8')).toBe(`${secondRecord}\n`)
        expect(readFileSync(historyPath, 'utf8')).toBe(`${seedRecord}\n`)
        const recovery = commitWithMaterialize(root, pendingPath, [
          '--allow-empty',
        ])
        const committed = spawnSync(
          'git',
          ['show', 'HEAD:docs/development/gate-history.jsonl'],
          { cwd: root, encoding: 'utf8', env: gitFixtureEnvironment() },
        )
        const state = spawnSync(
          'git',
          [
            'status',
            '--porcelain',
            '--',
            'docs/development/gate-history.jsonl',
          ],
          { cwd: root, encoding: 'utf8', env: gitFixtureEnvironment() },
        )
        expect(recovery.status, recovery.stderr).toBe(0)
        expect(committed.status).toBe(0)
        expect(committed.stdout).toBe(`${seedRecord}\n${secondRecord}\n`)
        expect(readFileSync(pendingPath, 'utf8')).toBe('')
        expect(state.status).toBe(0)
        expect(state.stdout).toBe('')
      },
    )
  },
)

describe(
  '物化暂存的失败形态与参数（gate-history.sh，issue #548）',
  { timeout: 30_000 },
  () => {
    afterEach(() => {
      for (const directory of temporaryDirectories.splice(0)) {
        rmSync(directory, { recursive: true, force: true })
      }
    })

    it('非 Git 仓库环境：暂存失败只警告 GATE_HISTORY_STAGE_FAILED，并入行保留未暂存、不阻塞', () => {
      const sandbox = mkdtempSync(resolve(tmpdir(), 'plotweave-gate-stage-'))
      temporaryDirectories.push(sandbox)
      mkdirSync(resolve(sandbox, 'scripts'), { recursive: true })
      mkdirSync(resolve(sandbox, 'docs/development'), { recursive: true })
      const historyPath = resolve(
        sandbox,
        'docs/development/gate-history.jsonl',
      )
      writeFileSync(historyPath, '')
      const pendingPath = resolve(sandbox, 'gate-pending.jsonl')
      writeFileSync(pendingPath, `${seedRecord}\n`)

      const result = runStageMaterialize(
        sandbox,
        historyPath,
        pendingPath,
        undefined,
      )

      expect(result.status).toBe(0)
      expect(
        readFileSync(historyPath, 'utf8').split('\n').filter(Boolean),
      ).toHaveLength(1)
      expect(result.stderr).toContain('GATE_HISTORY_STAGE_FAILED')
    })

    it('未知第二参数以非零退出并给出用法', () => {
      const sandbox = mkdtempSync(resolve(tmpdir(), 'plotweave-gate-stage-'))
      temporaryDirectories.push(sandbox)
      mkdirSync(resolve(sandbox, 'scripts'), { recursive: true })
      cpSync(
        resolve(repositoryRoot, 'scripts/gate-history.sh'),
        resolve(sandbox, 'scripts/gate-history.sh'),
      )
      const result = spawnSync(
        'sh',
        [
          resolve(sandbox, 'scripts/gate-history.sh'),
          'materialize',
          '--nonsense',
        ],
        { cwd: sandbox, encoding: 'utf8' },
      )

      expect(result.status).toBe(2)
      expect(result.stderr).toContain('用法')
    })
  },
)
