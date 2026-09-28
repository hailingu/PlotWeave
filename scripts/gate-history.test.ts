import {
  chmodSync,
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

type MaterializeOptions = {
  historyReadOnly?: boolean
  pending?: string
}

type MaterializeRun = {
  history: string
  pending: string
  status: number | null
  stderr: string
  stdout: string
}

/** 在隔离路径下执行真实物化脚本（issue #355，PR #415 评审 5338815626）。 */
function runMaterialize(options: MaterializeOptions = {}): MaterializeRun {
  const sandbox = mkdtempSync(resolve(tmpdir(), 'plotweave-gate-history-'))
  temporaryDirectories.push(sandbox)

  const historyPath = resolve(sandbox, 'gate-history.jsonl')
  const pendingPath = resolve(sandbox, 'gate-pending.jsonl')
  writeFileSync(historyPath, '')
  if (options.pending !== undefined) {
    writeFileSync(pendingPath, options.pending)
  }
  if (options.historyReadOnly) {
    chmodSync(historyPath, 0o444)
  }

  const result = spawnSync(
    'sh',
    [resolve(repositoryRoot, 'scripts/gate-history.sh'), 'materialize'],
    {
      cwd: repositoryRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        PLOTWEAVE_GATE_HISTORY_PATH: historyPath,
        PLOTWEAVE_GATE_PENDING_PATH: pendingPath,
      },
    },
  )

  return {
    history: readFileSync(historyPath, { encoding: 'utf8' }),
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

describe('门禁结论物化（gate-history.sh materialize，issue #355）', () => {
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

  it('版本化文件不可写时只警告、保留待物化行，不阻塞推送（尽力而为）', () => {
    const pending = '{"qualityGate":"OK"}\n'
    const result = runMaterialize({ historyReadOnly: true, pending })

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
})
