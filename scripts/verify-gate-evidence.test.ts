/** verify-gate-evidence.ts 的行为测试（issue #548）：在真实临时 Git 仓库
 * 中按物化时序构造台账演进，断言核验的退出码与稳定诊断码——诊断码是
 * scripts/verify-gate-evidence.ts 文件头文档化的机器可读契约，本文件按
 * 契约断言，不校验普通措辞。用例按「非 tip 证据判定 / tip 形态判定 /
 * 解析、范围与参数」分组，各 describe 回调保持在可执行单元行数上限内。 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'
import {
  gitFixtureEnvironment,
  gitScenarioFixture,
} from './git-scenario-fixture'

const repositoryRoot = resolve(import.meta.dirname, '..')
const verifierPath = resolve(repositoryRoot, 'scripts/verify-gate-evidence.ts')
const ledgerPath = 'docs/development/gate-history.jsonl'
const environment = gitFixtureEnvironment()

const fixtures: Array<ReturnType<typeof gitScenarioFixture>> = []

/** 在隔离环境中执行真实 git；失败即抛出，夹具播种不应有 git 错误。 */
function git(root: string, ...args: string[]): string {
  const result = spawnSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    env: environment,
  })
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} 失败：${result.stderr}`)
  }
  return result.stdout.trim()
}

function writeFile(root: string, path: string, content: string): void {
  const target = resolve(root, path)
  mkdirSync(resolve(target, '..'), { recursive: true })
  writeFileSync(target, content)
}

/** 向台账追加记录行；不动其他文件，配合调用方的提交构成物化形态。 */
function appendLedger(root: string, lines: string[]): void {
  if (lines.length === 0) return
  let existing = ''
  try {
    existing = readFileSync(resolve(root, ledgerPath), 'utf8')
  } catch {
    existing = ''
  }
  writeFile(root, ledgerPath, `${existing}${lines.join('\n')}\n`)
}

function commitAll(root: string, message: string): string {
  git(root, 'add', '-A')
  git(root, 'commit', '-q', '-m', message)
  return git(root, 'rev-parse', 'HEAD')
}

/** 生成一条台账通过记录行；覆盖项用于构造不通过或滞后的形态。 */
function recordLine(
  root: string,
  rev: string,
  overrides: { qualityGate?: string; newCode?: number } = {},
): string {
  return JSON.stringify({
    timestamp: '2026-10-16T00:00:00Z',
    tree: git(root, 'rev-parse', `${rev}^{tree}`),
    head: git(root, 'rev-parse', rev),
    qualityGate: overrides.qualityGate ?? 'OK',
    newCodeUnresolvedIssues: overrides.newCode ?? 0,
    frontendLineCoveragePercent: 96,
    rustLineCoveragePercent: 85,
  })
}

/** 播种基础场景：init + 历史台账记录 + base 提交，返回 base。 */
function seedBase(root: string): string {
  git(root, 'init', '--initial-branch=main')
  git(root, 'config', 'user.name', 'Scenario')
  git(root, 'config', 'user.email', 'scenario@example.invalid')
  appendLedger(root, [
    JSON.stringify({
      tree: 'f'.repeat(40),
      qualityGate: 'OK',
      newCodeUnresolvedIssues: 0,
    }),
  ])
  writeFile(root, 'src/app.txt', 'base\n')
  return commitAll(root, 'base')
}

/** 建场景并返回仓库根：seed 在首次 create 时执行一次。 */
function createSeeded(seed: (root: string, base: string) => void): string {
  const fixture = gitScenarioFixture((root) => {
    seed(root, seedBase(root))
  })
  fixtures.push(fixture)
  return fixture.create()
}

/** 在场景仓库上执行核验脚本，收集状态与合并输出。 */
function runVerifier(
  root: string,
  args: string[],
): { status: number | null; output: string } {
  const result = spawnSync(process.execPath, [verifierPath, ...args], {
    cwd: root,
    encoding: 'utf8',
    env: environment,
  })
  return { status: result.status, output: `${result.stdout}${result.stderr}` }
}

afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.dispose()
})

describe(
  '非 tip 提交的证据判定（verify-gate-evidence.ts，issue #548）',
  { timeout: 60_000 },
  () => {
    it('非 tip 提交缺失通过记录：退出 1 并逐条列出 GATE_EVIDENCE_MISSING', () => {
      const root = createSeeded((root) => {
        writeFile(root, 'src/app.txt', 'c1-绕过\n')
        commitAll(root, 'c1-绕过')
        writeFile(root, 'src/app.txt', 'c2\n')
        commitAll(root, 'c2')
      })

      const result = runVerifier(root, ['--base', 'main~2', '--head', 'HEAD'])

      expect(result.status).toBe(1)
      expect(result.output).toContain('[GATE_EVIDENCE_MISSING]')
      expect(result.output).toContain('c1-绕过')
      expect(result.output).toContain('修复指引')
    })

    it('记录存在但 qualityGate 非 OK 或新增问题非零：不构成证据，退出 1', () => {
      const root = createSeeded((root) => {
        writeFile(root, 'src/app.txt', 'c1\n')
        const c1 = commitAll(root, 'c1')
        writeFile(root, 'src/app.txt', 'c2\n')
        const c2 = commitAll(root, 'c2')
        appendLedger(root, [
          recordLine(root, c1, { qualityGate: 'ERROR' }),
          recordLine(root, c1, { newCode: 2 }),
          recordLine(root, c2),
        ])
        commitAll(root, '物化台账')
      })

      const result = runVerifier(root, ['--base', 'main~3', '--head', 'HEAD'])

      expect(result.status).toBe(1)
      expect(result.output).toContain('[GATE_EVIDENCE_MISSING]')
      expect(result.output).toContain('（c1）')
    })

    it('revert 台账补充提交会把此前的证据一并剥离：非 tip 提交判缺失、退出 1', () => {
      const root = createSeeded((root) => {
        writeFile(root, 'src/app.txt', 'c1\n')
        const c1 = commitAll(root, 'c1')
        appendLedger(root, [recordLine(root, c1)])
        commitAll(root, '物化台账')
        // revert 撤销台账补充提交，c1 的证据行随台账回到补充前状态
        git(root, 'revert', '--no-edit', 'HEAD')
      })

      const result = runVerifier(root, ['--base', 'main~3', '--head', 'HEAD'])

      expect(result.status).toBe(1)
      expect(result.output).toContain('[GATE_EVIDENCE_MISSING]')
      expect(result.output).toContain('（c1）')
    })
  },
)

describe(
  'tip 形态判定（verify-gate-evidence.ts，issue #548）',
  { timeout: 60_000 },
  () => {
    it('tip 自身记录滞后一次提交：通过但输出 GATE_EVIDENCE_TIP_LAG 告警', () => {
      const root = createSeeded((root) => {
        writeFile(root, 'src/app.txt', 'c1\n')
        const c1 = commitAll(root, 'c1')
        writeFile(root, 'src/app.txt', 'c2\n')
        appendLedger(root, [recordLine(root, c1)])
        commitAll(root, 'c2')
      })

      const result = runVerifier(root, ['--base', 'main~2', '--head', 'HEAD'])

      expect(result.status).toBe(0)
      expect(result.output).toContain('GATE_EVIDENCE_TIP_LAG')
    })

    it('单提交 PR 且 tip 未留证：通过但告警滞后', () => {
      const root = createSeeded((root) => {
        writeFile(root, 'src/app.txt', 'c1\n')
        commitAll(root, 'c1')
      })

      const result = runVerifier(root, ['--base', 'main~1', '--head', 'HEAD'])

      expect(result.status).toBe(0)
      expect(result.output).toContain('GATE_EVIDENCE_TIP_LAG')
    })

    it('tip 仅改台账（物化补充提交）：豁免且无告警', () => {
      const root = createSeeded((root) => {
        writeFile(root, 'src/app.txt', 'c1\n')
        const c1 = commitAll(root, 'c1')
        appendLedger(root, [recordLine(root, c1)])
        commitAll(root, 'chore 物化台账')
      })

      const result = runVerifier(root, ['--base', 'main~2', '--head', 'HEAD'])

      expect(result.status).toBe(0)
      expect(result.output).toContain('GATE_EVIDENCE_LEDGER_ONLY_TIP')
      expect(result.output).not.toContain('GATE_EVIDENCE_TIP_LAG')
    })

    it('合并提交不适用台账-only 豁免：作为 tip 滞后仅告警，范围内其余提交留证即通过', () => {
      const root = createSeeded((root) => {
        writeFile(root, 'src/app.txt', 'c1\n')
        const c1 = commitAll(root, 'c1')
        git(root, 'checkout', '-b', 'side', 'main~1')
        writeFile(root, 'src/side.txt', 'side\n')
        const s1 = commitAll(root, 's1')
        git(root, 'checkout', 'main')
        appendLedger(root, [recordLine(root, c1), recordLine(root, s1)])
        const c2 = commitAll(root, '物化台账')
        git(root, 'merge', '--no-ff', '--no-commit', 'side')
        appendLedger(root, [recordLine(root, c2)])
        commitAll(root, 'merge side')
      })

      const result = runVerifier(root, ['--base', 'main~3', '--head', 'HEAD'])

      expect(result.status).toBe(0)
      expect(result.output).toContain('GATE_EVIDENCE_TIP_LAG')
      expect(result.output).not.toContain('GATE_EVIDENCE_LEDGER_ONLY_TIP')
      expect(result.output).not.toContain('[GATE_EVIDENCE_MISSING]')
    })
  },
)

describe(
  '台账解析、范围与参数（verify-gate-evidence.ts，issue #548）',
  { timeout: 60_000 },
  () => {
    it('台账畸形行跳过并告警，有效记录仍参与判定', () => {
      const root = createSeeded((root) => {
        writeFile(root, 'src/app.txt', 'c1\n')
        const c1 = commitAll(root, 'c1')
        writeFile(root, 'src/app.txt', 'c2\n')
        const c2 = commitAll(root, 'c2')
        appendLedger(root, [
          '{broken-json',
          recordLine(root, c1),
          recordLine(root, c2),
        ])
        commitAll(root, '物化台账')
      })

      const result = runVerifier(root, ['--base', 'main~3', '--head', 'HEAD'])

      expect(result.status).toBe(0)
      expect(result.output).toContain('GATE_EVIDENCE_MALFORMED_LINE')
      expect(result.output).not.toContain('[GATE_EVIDENCE_MISSING]')
    })

    it('范围内无提交（head 即基）：通过', () => {
      const root = createSeeded((root) => {
        writeFile(root, 'src/app.txt', 'c1\n')
        commitAll(root, 'c1')
      })

      const result = runVerifier(root, ['--base', 'HEAD', '--head', 'HEAD'])

      expect(result.status).toBe(0)
      expect(result.output).toContain('没有待合并提交')
    })

    it('缺少 --base 或未知参数：退出 2 并给出用法', () => {
      const root = createSeeded((root) => {
        writeFile(root, 'src/app.txt', 'c1\n')
        commitAll(root, 'c1')
      })

      const missingBase = runVerifier(root, ['--head', 'HEAD'])
      const unknownFlag = runVerifier(root, ['--base', 'main~1', '--fast'])

      expect(missingBase.status).toBe(2)
      expect(missingBase.output).toContain('用法')
      expect(unknownFlag.status).toBe(2)
      expect(unknownFlag.output).toContain('未知参数')
    })
  },
)
