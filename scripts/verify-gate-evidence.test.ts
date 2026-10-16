/** verify-gate-evidence.ts 的行为测试（issue #548）：在真实临时 Git 仓库
 * 中按物化时序构造台账演进，断言核验的退出码与稳定诊断码——诊断码是
 * scripts/verify-gate-evidence.ts 文件头文档化的机器可读契约，本文件按
 * 契约断言，不校验普通措辞。用例按「非 tip 证据判定 / tip 形态判定 /
 * 解析、范围与参数」分组，各 describe 回调保持在可执行单元行数上限内。 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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

/** 同上但不预置基线：种子自建完整历史（发布形态需要早于台账入库的
 * base 提交，不能经 seedBase 预写台账）。 */
function createRawSeeded(seed: (root: string) => void): string {
  const fixture = gitScenarioFixture(seed)
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

    it('台账超过 execFileSync 默认缓冲（>1 MiB）仍完整读取并正常判定（PR #581 评审 5542889511）', () => {
      const root = createSeeded((root) => {
        writeFile(root, 'src/app.txt', 'c1\n')
        const c1 = commitAll(root, 'c1')
        // 填充记录使台账体积超过 1 MiB（默认 maxBuffer），假 tree 不与
        // 范围内任何提交树碰撞；有效记录（c1）缀在末尾
        const padding = Array.from({ length: 12_000 }, (_, index) =>
          JSON.stringify({
            tree: `${'p'.repeat(39)}${index % 10}`,
            qualityGate: 'OK',
            newCodeUnresolvedIssues: 0,
          }),
        )
        appendLedger(root, [...padding, recordLine(root, c1)])
        commitAll(root, '物化台账')
      })

      const result = runVerifier(root, ['--base', 'main~2', '--head', 'HEAD'])

      expect(result.status).toBe(0)
      expect(result.output).not.toContain('[GATE_EVIDENCE_MISSING]')
      expect(result.output).toContain('GATE_EVIDENCE_LEDGER_ONLY_TIP')
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

describe(
  '发布集成边界的豁免通过（--release-boundary，dev → main 形态，PR #581 评审 5542207474）',
  { timeout: 60_000 },
  () => {
    afterEach(() => {
      for (const fixture of fixtures.splice(0)) fixture.dispose()
    })

    it('合并提交跳过、被集成分支 tip 与台账前历史豁免：发布范围通过且仅告警', () => {
      const root = createRawSeeded((root) => {
        // base 与 c1 早于台账入库（树中无台账路径）
        git(root, 'init', '--initial-branch=main')
        git(root, 'config', 'user.name', 'Scenario')
        git(root, 'config', 'user.email', 'scenario@example.invalid')
        writeFile(root, 'src/app.txt', 'base\n')
        const b0 = commitAll(root, 'release-base')
        git(root, 'tag', 'release-base', b0)
        writeFile(root, 'src/app.txt', 'c1\n')
        commitAll(root, 'c1')
        // c2 引入台账；自身记录与 s1 的记录随合并提交 M1 写入
        appendLedger(root, [
          JSON.stringify({
            tree: 'f'.repeat(40),
            qualityGate: 'OK',
            newCodeUnresolvedIssues: 0,
          }),
        ])
        const c2 = commitAll(root, 'c2 引入台账')
        git(root, 'checkout', '-q', '-b', 'side1', 'main')
        writeFile(root, 'src/side1.txt', 'side1\n')
        const s1 = commitAll(root, 's1')
        git(root, 'checkout', '-q', 'main')
        git(root, 'merge', '--no-ff', '--no-commit', 'side1')
        appendLedger(root, [recordLine(root, c2), recordLine(root, s1)])
        commitAll(root, 'M1')
        // side2 的 tip t1 无入库记录：其记录按物化时序留在开发者本地
        git(root, 'checkout', '-q', '-b', 'side2', 'main')
        writeFile(root, 'src/side2.txt', 'side2\n')
        commitAll(root, 't1')
        git(root, 'checkout', '-q', 'main')
        git(root, 'merge', '--no-ff', '--no-commit', 'side2')
        commitAll(root, 'M2')
      })

      const result = runVerifier(root, [
        '--base',
        'release-base',
        '--head',
        'HEAD',
        '--release-boundary',
      ])

      expect(result.status).toBe(0)
      expect(result.output).not.toContain('[GATE_EVIDENCE_MISSING]')
      expect(result.output).toContain('GATE_EVIDENCE_PRE_LEDGER_COMMIT')
      expect(result.output).toContain('GATE_EVIDENCE_INTEGRATED_TIP_LAG')
      expect(result.output).toContain('GATE_EVIDENCE_TIP_LAG')
      expect(result.output).toContain('合并提交跳过 1')
    })
  },
)

describe(
  '发布范围内普通直链提交缺证据仍失败（--release-boundary，PR #581 评审 5542207474）',
  { timeout: 60_000 },
  () => {
    afterEach(() => {
      for (const fixture of fixtures.splice(0)) fixture.dispose()
    })

    it('豁免不外溢：发布范围内普通直链提交缺记录仍失败', () => {
      const root = createRawSeeded((root) => {
        git(root, 'init', '--initial-branch=main')
        git(root, 'config', 'user.name', 'Scenario')
        git(root, 'config', 'user.email', 'scenario@example.invalid')
        writeFile(root, 'src/app.txt', 'base\n')
        const b0 = commitAll(root, 'release-base')
        git(root, 'tag', 'release-base', b0)
        writeFile(root, 'src/app.txt', 'c1\n')
        commitAll(root, 'c1')
        appendLedger(root, [
          JSON.stringify({
            tree: 'f'.repeat(40),
            qualityGate: 'OK',
            newCodeUnresolvedIssues: 0,
          }),
        ])
        const c2 = commitAll(root, 'c2 引入台账')
        // c2 的直链后继提交：既非合并、非集成分支 tip、也非范围 tip
        writeFile(root, 'src/dev-direct.txt', 'direct\n')
        commitAll(root, 'c2b-直链绕过')
        git(root, 'checkout', '-q', '-b', 'side1', 'main')
        writeFile(root, 'src/side1.txt', 'side1\n')
        const s1 = commitAll(root, 's1')
        git(root, 'checkout', '-q', 'main')
        git(root, 'merge', '--no-ff', '--no-commit', 'side1')
        appendLedger(root, [recordLine(root, c2), recordLine(root, s1)])
        commitAll(root, 'M1')
      })

      const result = runVerifier(root, [
        '--base',
        'release-base',
        '--head',
        'HEAD',
        '--release-boundary',
      ])

      expect(result.status).toBe(1)
      expect(result.output).toContain('[GATE_EVIDENCE_MISSING]')
      expect(result.output).toContain('c2b-直链绕过')
    })
  },
)

describe(
  '集成边界豁免的模式门控与删除台账反例（PR #581 评审 5542342537）',
  { timeout: 60_000 },
  () => {
    afterEach(() => {
      for (const fixture of fixtures.splice(0)) fixture.dispose()
    })

    it('task PR（无 --release-boundary）：合并提交与非首父同样必须留证', () => {
      const root = createSeeded((root) => {
        git(root, 'checkout', '-q', '-b', 'side', 'main')
        writeFile(root, 'src/side.txt', 'side\n')
        commitAll(root, 's1-无记录')
        git(root, 'checkout', '-q', 'main')
        git(root, 'merge', '--no-ff', '--no-commit', 'side')
        commitAll(root, 'merge side')
        writeFile(root, 'src/app.txt', 'tip\n')
        commitAll(root, 'tip')
      })

      const result = runVerifier(root, ['--base', 'main~2', '--head', 'HEAD'])

      expect(result.status).toBe(1)
      expect(result.output).toContain('[GATE_EVIDENCE_MISSING]')
      expect(result.output).not.toContain('GATE_EVIDENCE_INTEGRATED_TIP_LAG')
      expect(result.output).not.toContain('GATE_EVIDENCE_PRE_LEDGER_COMMIT')
    })

    it('删除台账的提交不属台账前历史：发布模式下仍判缺失（零记录不可借道删除）', () => {
      const root = createRawSeeded((root) => {
        git(root, 'init', '--initial-branch=main')
        git(root, 'config', 'user.name', 'Scenario')
        git(root, 'config', 'user.email', 'scenario@example.invalid')
        writeFile(root, 'src/app.txt', 'base\n')
        const b0 = commitAll(root, 'release-base')
        git(root, 'tag', 'release-base', b0)
        appendLedger(root, [
          JSON.stringify({
            tree: 'f'.repeat(40),
            qualityGate: 'OK',
            newCodeUnresolvedIssues: 0,
          }),
        ])
        const c1 = commitAll(root, 'c1 引入台账')
        // c2 删除台账并改源码：触及台账路径，不属于台账前历史
        rmSync(resolve(root, ledgerPath))
        writeFile(root, 'src/app.txt', 'c2-删除台账\n')
        commitAll(root, 'c2-删除台账')
        // c3 仅恢复台账并携带 c1 的记录（tip = 台账-only 豁免形态）
        appendLedger(root, [recordLine(root, c1)])
        commitAll(root, 'c3 恢复台账')
      })

      const result = runVerifier(root, [
        '--base',
        'release-base',
        '--head',
        'HEAD',
        '--release-boundary',
      ])

      expect(result.status).toBe(1)
      expect(result.output).toContain('[GATE_EVIDENCE_MISSING]')
      expect(result.output).toContain('c2-删除台账')
      expect(result.output).toContain('GATE_EVIDENCE_LEDGER_ONLY_TIP')
    })
  },
)

describe(
  '台账-only 豁免仅限保留原字节的纯追加（PR #581 评审 5543033431）',
  { timeout: 60_000 },
  () => {
    afterEach(() => {
      for (const fixture of fixtures.splice(0)) fixture.dispose()
    })

    it('tip 删除整个台账：不豁免，仅按 tip 滞后告警', () => {
      const root = createSeeded((root) => {
        rmSync(resolve(root, ledgerPath))
        commitAll(root, '删除台账')
      })

      const result = runVerifier(root, ['--base', 'main~1', '--head', 'HEAD'])

      expect(result.status).toBe(0)
      expect(result.output).not.toContain('GATE_EVIDENCE_LEDGER_ONLY_TIP')
      expect(result.output).toContain('GATE_EVIDENCE_TIP_LAG')
    })

    it('tip 重写既有台账行（非纯追加）：不豁免，仅按 tip 滞后告警', () => {
      const root = createSeeded((root) => {
        writeFile(
          root,
          ledgerPath,
          `${JSON.stringify({
            tree: 'e'.repeat(40),
            qualityGate: 'OK',
            newCodeUnresolvedIssues: 0,
          })}\n`,
        )
        commitAll(root, '重写台账')
      })

      const result = runVerifier(root, ['--base', 'main~1', '--head', 'HEAD'])

      expect(result.status).toBe(0)
      expect(result.output).not.toContain('GATE_EVIDENCE_LEDGER_ONLY_TIP')
      expect(result.output).toContain('GATE_EVIDENCE_TIP_LAG')
    })
  },
)
