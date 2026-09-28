import {
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
