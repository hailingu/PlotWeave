/** 服务端门禁证据核验（issue #548 方案 1）：对照版本化门禁台账
 * docs/development/gate-history.jsonl（issue #355）复核 PR 合并范围内的
 * 提交确有「门禁通过」的自述证据。判定键与台账一致：记录的 tree 字段
 * （门禁校验的索引树）等于提交树、qualityGate 为 OK 且新增代码未解决
 * 问题为 0。提交创建钩子已在门禁前把待物化记录并入并暂存进后续提交
 * （issue #548），因此范围内除最后一个提交（tip）外的每个提交都必须在
 * head 版台账中留有证据；tip 自身的门禁记录（提交与推送两轮运行）按物
 * 化时序只存在于下一次提交，仅输出告警，或在 tip 只改台账时豁免（该形
 * 态不携带源码变更）。
 * 台账无签名（issue #431 信任边界）：本核验建立的是留证义务与绕过成
 * 本，不是对门禁执行的独立证明。
 *
 * 稳定诊断码（测试与 CI 按此契约断言）：
 * - [GATE_EVIDENCE_MISSING]：非 tip 提交缺失通过记录（核验失败）。
 * - [GATE_EVIDENCE_TIP_LAG]：tip 缺失自身记录（告警，不失败）。
 * - [GATE_EVIDENCE_INTEGRATED_TIP_LAG]：发布范围中被集成分支的 tip
 *   （某合并提交的非首父）缺失记录（告警，不失败）——其记录按物化时序
 *   留在开发者本地下一次提交中，晚于本次发布落地（PR #581 评审）。
 * - [GATE_EVIDENCE_PRE_LEDGER_COMMIT]：台账尚未入库的历史提交（其树中
 *   不存在台账路径）豁免记录要求（提示，不失败）。
 * - [GATE_EVIDENCE_LEDGER_ONLY_TIP]：tip 仅改台账，豁免（提示）。
 * - [GATE_EVIDENCE_MALFORMED_LINE]：台账中无法解析的行被跳过（告警）。
 *
 * 用法：node scripts/verify-gate-evidence.ts --base <rev> [--head <rev>]
 * 退出码：0 通过（可含告警）；1 证据缺失；2 参数或 Git 错误。 */

import { execFileSync } from 'node:child_process'

/** 版本化台账在仓库内的固定路径（与 scripts/gate-history.sh 默认值一致）。 */
const ledgerPath = 'docs/development/gate-history.jsonl'

/** 台账行的最小判定字段；多余字段忽略，台账字段演进不破坏核验。 */
type LedgerRecord = {
  tree?: unknown
  qualityGate?: unknown
  newCodeUnresolvedIssues?: unknown
}

/** 一次待报告的提交判定结果。 */
type CommitFinding = { short: string; subject: string; tree: string }

/** 一个范围内的提交及其判定素材。 */
type RangeCommit = {
  sha: string
  short: string
  subject: string
  tree: string
  parentCount: number
  /** 首父之外的全部父提交（合并提交的第二/更多父 = 被集成分支 tip）。 */
  integratedParents: string[]
  changedFiles: string[]
}

/** 核验结论：缺失列表（失败项）、tip 形态与发布边界豁免统计。 */
type Verification = {
  missing: CommitFinding[]
  tipStatus: 'evidenced' | 'ledger-only' | 'lagging'
  tipFinding: CommitFinding
  integratedTipWarnings: CommitFinding[]
  preLedgerNotes: CommitFinding[]
  skippedMerges: number
}

class UsageError extends Error {}

/** 以与推送门禁一致的对象视图执行 git（PR #442：忽略本地替换引用）。
 * stderr 显式 pipe：失败探测（如 cat-file -e）不得把子进程诊断漏进
 * 调用方输出。 */
function runGit(args: string[], allowFailure = false): string {
  try {
    return execFileSync('git', args, {
      encoding: 'utf8',
      env: { ...process.env, GIT_NO_REPLACE_OBJECTS: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch (error) {
    if (allowFailure) return ''
    const reason = error instanceof Error ? error.message : String(error)
    throw new UsageError(`git ${args.join(' ')} 执行失败：${reason}`)
  }
}

/** 解析命令行参数；--base 必填，--head 缺省 HEAD。 */
function parseArguments(argv: string[]): { base: string; head: string } {
  let base: string | undefined
  let head = 'HEAD'
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--base' && argv[index + 1] !== undefined) {
      base = argv[index + 1]
      index += 1
    } else if (argument === '--head' && argv[index + 1] !== undefined) {
      head = argv[index + 1]
      index += 1
    } else {
      throw new UsageError(`未知参数或缺值：${argument}`)
    }
  }
  if (base === undefined) {
    throw new UsageError('缺少 --base <rev>（PR 目标分支或合并基）')
  }
  return { base, head }
}

/** 读取 head 版台账并提取通过记录的 tree 集合；畸形行计数告警但不失败。 */
function readEvidenceTrees(head: string): {
  trees: Set<string>
  malformedLines: number
} {
  const content = runGit(['show', `${head}:${ledgerPath}`], true)
  const trees = new Set<string>()
  let malformedLines = 0
  for (const line of content.split('\n')) {
    if (line.trim() === '') continue
    try {
      const record: LedgerRecord = JSON.parse(line) as LedgerRecord
      if (
        typeof record.tree === 'string' &&
        record.tree !== '' &&
        record.qualityGate === 'OK' &&
        record.newCodeUnresolvedIssues === 0
      ) {
        trees.add(record.tree)
      }
    } catch {
      malformedLines += 1
    }
  }
  return { trees, malformedLines }
}

/** 枚举合并基（不含）到 head（含）的提交，由旧到新；含合并提交。 */
function listRangeCommits(base: string, head: string): string[] {
  const mergeBase = runGit(['merge-base', base, head]).trim()
  if (mergeBase === '') {
    throw new UsageError(`无法确定 ${base} 与 ${head} 的合并基`)
  }
  const output = runGit([
    'rev-list',
    '--reverse',
    `${mergeBase}..${head}`,
  ]).trim()
  return output === '' ? [] : output.split('\n')
}

/** 收集一个提交的判定素材：树、主题、父数与相对唯一父提交的变更文件。 */
function describeCommit(sha: string): RangeCommit {
  const parents =
    runGit(['rev-list', '--parents', '-n', '1', sha])
      .trim()
      .split('\n')[0]
      ?.split(' ') ?? []
  const parentShas = parents.slice(1)
  const changedFiles =
    parentShas.length === 1
      ? runGit(['diff', '--name-only', parentShas[0] ?? '', sha])
          .trim()
          .split('\n')
          .filter((path) => path !== '')
      : []
  return {
    sha,
    short: runGit(['rev-parse', '--short', sha]).trim(),
    subject: runGit(['log', '-1', '--format=%s', sha]).trim(),
    tree: runGit(['rev-parse', `${sha}^{tree}`]).trim(),
    parentCount: parentShas.length,
    integratedParents: parentShas.slice(1),
    changedFiles,
  }
}

/** 提交树中是否已存在台账路径（issue #355 之前的历史提交豁免依据）。 */
function commitHasLedger(commit: RangeCommit): boolean {
  try {
    runGit(['cat-file', '-e', `${commit.sha}:${ledgerPath}`])
    return true
  } catch {
    return false
  }
}

/** tip 是否只改台账：单父、有变更、且全部变更落在台账路径（合并提交不豁免）。 */
function isLedgerOnlyTip(commit: RangeCommit): boolean {
  return (
    commit.parentCount === 1 &&
    commit.changedFiles.length > 0 &&
    commit.changedFiles.every((path) => path === ledgerPath)
  )
}

/** 发布边界集合：范围内合并提交的键（跳过）与其非首父（集成分支 tip）。
 * 服务端集成的合并提交在本地未经门禁、其内容已由各组成 PR 的核验覆
 * 盖（分支保护保证入库必经 PR）；被集成分支的 tip 在自己的 PR 里按
 * tip 滞后豁免，其记录随开发者下一次提交物化、晚于发布落地。 */
function collectIntegrationBoundaries(commits: RangeCommit[]): {
  mergeShas: Set<string>
  integratedTipShas: Set<string>
} {
  const mergeShas = new Set<string>()
  const integratedTipShas = new Set<string>()
  for (const commit of commits) {
    if (commit.parentCount >= 2) {
      mergeShas.add(commit.sha)
      for (const parent of commit.integratedParents) {
        integratedTipShas.add(parent)
      }
    }
  }
  return { mergeShas, integratedTipShas }
}

/** 逐提交判定：发布边界（合并提交/集成分支 tip/台账前历史）之外的
 * 非 tip 提交必须有证据；范围 tip 按记录/豁免/滞后三态归类。 */
function verifyRange(
  commits: RangeCommit[],
  evidenceTrees: Set<string>,
): Verification {
  const missing: CommitFinding[] = []
  const integratedTipWarnings: CommitFinding[] = []
  const preLedgerNotes: CommitFinding[] = []
  const tip = commits[commits.length - 1]
  const { mergeShas, integratedTipShas } = collectIntegrationBoundaries(commits)
  let skippedMerges = 0
  for (const commit of commits) {
    if (commit === tip) continue
    const finding: CommitFinding = {
      short: commit.short,
      subject: commit.subject,
      tree: commit.tree,
    }
    if (mergeShas.has(commit.sha)) {
      skippedMerges += 1
      continue
    }
    if (evidenceTrees.has(commit.tree)) continue
    if (integratedTipShas.has(commit.sha)) {
      integratedTipWarnings.push(finding)
      continue
    }
    if (!commitHasLedger(commit)) {
      preLedgerNotes.push(finding)
      continue
    }
    missing.push(finding)
  }
  const tipFinding = { short: tip.short, subject: tip.subject, tree: tip.tree }
  let tipStatus: Verification['tipStatus'] = 'lagging'
  if (evidenceTrees.has(tip.tree)) {
    tipStatus = 'evidenced'
  } else if (isLedgerOnlyTip(tip)) {
    tipStatus = 'ledger-only'
  }
  return {
    missing,
    tipStatus,
    tipFinding,
    integratedTipWarnings,
    preLedgerNotes,
    skippedMerges,
  }
}

/** 输出告警：GitHub Actions 中以工作流命令呈现为注解，本地为纯文本。 */
function emitWarning(message: string): void {
  if (process.env.GITHUB_ACTIONS === 'true') {
    console.log(`::warning::${message}`)
  } else {
    console.log(`警告：${message}`)
  }
}

/** 核验主流程：参数解析 → 范围枚举 → 台账比对 → 结论输出与退出码。 */
function main(): number {
  const { base, head } = parseArguments(process.argv.slice(2))
  const commits = listRangeCommits(base, head)
  if (commits.length === 0) {
    console.log('[gate-evidence] 范围内没有待合并提交，核验通过。')
    return 0
  }
  const { trees, malformedLines } = readEvidenceTrees(head)
  if (malformedLines > 0) {
    emitWarning(
      `[GATE_EVIDENCE_MALFORMED_LINE] 台账有 ${malformedLines} 行无法解析，已跳过（日志语义，不阻塞）。`,
    )
  }
  const described = commits.map((sha) => describeCommit(sha))
  const verification = verifyRange(described, trees)
  const evidencedCount = described.filter((commit) =>
    trees.has(commit.tree),
  ).length
  for (const finding of verification.missing) {
    console.log(
      `[GATE_EVIDENCE_MISSING] ${finding.short}（${finding.subject}）在 head 版台账没有通过记录（tree ${finding.tree}）`,
    )
  }
  for (const finding of verification.integratedTipWarnings) {
    emitWarning(
      `[GATE_EVIDENCE_INTEGRATED_TIP_LAG] ${finding.short}（${finding.subject}）是被集成分支的 tip：其记录随开发者下一次提交物化、晚于本次发布落地，本次不判失败。`,
    )
  }
  for (const finding of verification.preLedgerNotes) {
    console.log(
      `[GATE_EVIDENCE_PRE_LEDGER_COMMIT] ${finding.short}（${finding.subject}）早于台账入库，豁免记录要求。`,
    )
  }
  if (verification.tipStatus === 'lagging') {
    const finding = verification.tipFinding
    emitWarning(
      `[GATE_EVIDENCE_TIP_LAG] tip ${finding.short}（${finding.subject}）的门禁记录随下一次提交物化，本次不判失败；若需消除告警，可将物化记录随下一次变更提交。`,
    )
  } else if (verification.tipStatus === 'ledger-only') {
    console.log(
      `[GATE_EVIDENCE_LEDGER_ONLY_TIP] tip ${verification.tipFinding.short} 仅改台账，豁免自身记录要求。`,
    )
  }
  const boundarySummary = [
    verification.skippedMerges > 0
      ? `合并提交跳过 ${verification.skippedMerges}`
      : '',
    verification.integratedTipWarnings.length > 0
      ? `集成 tip 告警 ${verification.integratedTipWarnings.length}`
      : '',
    verification.preLedgerNotes.length > 0
      ? `台账前历史豁免 ${verification.preLedgerNotes.length}`
      : '',
  ]
    .filter((part) => part !== '')
    .join('，')
  console.log(
    `[gate-evidence] 范围 ${described.length} 个提交，${evidencedCount} 个有台账证据，tip 状态 ${verification.tipStatus}` +
      (boundarySummary === '' ? '。' : `（${boundarySummary}）。`),
  )
  if (verification.missing.length > 0) {
    console.log(
      '修复指引：正常工作流（钩子已安装：npm run hooks:install）在每次提交前自动并入并暂存台账记录；缺失通常意味着提交创建时门禁未运行或被绕过（issue #548）。若分支经过 rebase / cherry-pick / revert 重放：重放提交的证据由 prepare-commit-msg 回退门禁记入待物化文件、随下一个普通提交并入——执行 git commit --allow-empty 并重推即可补全证据。',
    )
    return 1
  }
  return 0
}

try {
  process.exit(main())
} catch (error) {
  if (error instanceof UsageError) {
    console.error(`gate-evidence 失败：${error.message}`)
    console.error(
      '用法：node scripts/verify-gate-evidence.ts --base <rev> [--head <rev>]',
    )
    process.exit(2)
  }
  throw error
}
