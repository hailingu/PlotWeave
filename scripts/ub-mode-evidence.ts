/** #941：本地 ub-mode 记录的对象、期限与产物绑定；不把自报记录当防篡改证明。 */
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { homedir } from 'node:os'

/** 成功执行保存的本机产物摘要。 */
export interface UbArtifact {
  path: string
  sha256: string
}
/** 固定四项检查；人工模式只允许技能明确支持的降级。 */
export interface UbCheck {
  name: string
  mode: 'tool' | 'manual'
  command: string[]
  artifact: UbArtifact
}
/** 与一个最终提交绑定的本机检查记录；24 小时后需重新执行。 */
export interface UbReceipt {
  version: 1
  head: string
  tree: string
  base: string
  finishedAt: number
  skill: UbArtifact
  review: UbArtifact
  checks: UbCheck[]
}

/** 显式仓库拥有对象和索引定位；不继承调用方 Git 定位，也不接受 replace 映射。 */
export function ubGit(root: string, args: string[]): string {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_NO_REPLACE_OBJECTS: '1' }
  for (const key of [
    'GIT_DIR',
    'GIT_WORK_TREE',
    'GIT_INDEX_FILE',
    'GIT_PREFIX',
    'GIT_COMMON_DIR',
    'GIT_OBJECT_DIRECTORY',
    'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  ])
    delete env[key]
  return execFileSync('git', ['-C', root, ...args], {
    encoding: 'utf8',
    env,
  }).trim()
}

/** 精确字节摘要用于检测技能、人工审查和日志在检查后发生变化。 */
export function ubArtifact(path: string): UbArtifact {
  return {
    path,
    sha256: createHash('sha256').update(readFileSync(path)).digest('hex'),
  }
}

/** 找到真实技能来源；显式路径优先，其次仓库及个人技能。不存在即失败。 */
export function ubSkill(root: string): UbArtifact {
  const paths = process.env.PLOTWEAVE_UB_SKILL
    ? [process.env.PLOTWEAVE_UB_SKILL]
    : [
        resolve(root, '.agents/skills/ub-mode/SKILL.md'),
        resolve(homedir(), '.agents/skills/ub-mode/SKILL.md'),
        resolve(homedir(), '.codex/skills/ub-mode/SKILL.md'),
      ]
  for (const path of paths) {
    try {
      ubRequire(
        /^name:\s*ub-mode\s*$/m.test(readFileSync(path, 'utf8')),
        'UB_MODE_SKILL_INVALID',
      )
      return ubArtifact(path)
    } catch {
      /* 继续真实来源发现，不生成通过记录。 */
    }
  }
  throw new Error('[UB_MODE_SKILL_MISSING] 找不到真实 ub-mode SKILL.md')
}

/** linked worktree 共用记录目录，各提交独占产物，不接触 pending/index/ledger。 */
export function ubReceiptDirectory(root: string, head: string): string {
  return resolve(
    ubGit(root, ['rev-parse', '--path-format=absolute', '--git-common-dir']),
    'plotweave-ub-mode',
    head,
  )
}

/** 断言边界失败时保留稳定诊断代码，供 hook、PR 及回归使用。 */
export function ubRequire(condition: unknown, code: string): asserts condition {
  if (!condition) throw new Error(`[${code}] ub-mode 发布检查未通过`)
}

/** 基线只能扩大 dev 分叉点的范围，不能跳过任务分支上的任何改动。 */
export function requireUbBase(root: string, base: string, head: string): void {
  const integration = ubGit(root, ['merge-base', 'dev', head])
  ubRequire(
    ubGit(root, ['merge-base', base, integration]) === base,
    'UB_MODE_BASE_MISMATCH',
  )
}

/** 解析外部 JSON 后一次验证结构、对象、时效及完整的实际检查产物。 */
export function validateUbReceipt(
  value: unknown,
  head: string,
  tree: string,
  skill: UbArtifact,
  now: number,
): UbReceipt {
  ubRequire(typeof value === 'object' && value !== null, 'UB_MODE_INVALID')
  const receipt = value as Partial<UbReceipt>
  ubRequire(
    receipt.version === 1 && receipt.head === head && receipt.tree === tree,
    'UB_MODE_OBJECT_MISMATCH',
  )
  ubRequire(
    typeof receipt.base === 'string' &&
      /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(receipt.base),
    'UB_MODE_BASE_MISMATCH',
  )
  ubRequire(
    typeof receipt.finishedAt === 'number' &&
      Number.isFinite(receipt.finishedAt),
    'UB_MODE_INVALID',
  )
  ubRequire(
    receipt.finishedAt <= now && now - receipt.finishedAt < 86_400_000,
    'UB_MODE_EXPIRED',
  )
  ubRequire(receipt.skill?.sha256 === skill.sha256, 'UB_MODE_SKILL_CHANGED')
  ubRequire(Array.isArray(receipt.checks), 'UB_MODE_INVALID')
  ubRequire(
    receipt.checks.map((check) => check.name).join(',') ===
      'coverage,complexity,duplication,mutation',
    'UB_MODE_INCOMPLETE',
  )
  for (const check of receipt.checks) validateUbCheck(check)
  verifyUbArtifact(receipt.review)
  return receipt as UbReceipt
}

/** 检查模式和命令必须有真实日志，不能靠 status/pass 布尔值放行。 */
function validateUbCheck(check: UbCheck): void {
  ubRequire(check.mode === 'tool' || check.mode === 'manual', 'UB_MODE_INVALID')
  ubRequire(
    Array.isArray(check.command) &&
      check.command.length > 0 &&
      check.command.every(
        (part) => typeof part === 'string' && part.length > 0,
      ),
    'UB_MODE_INVALID',
  )
  ubRequire(
    check.name !== 'coverage' || check.mode === 'tool',
    'UB_MODE_INCOMPLETE',
  )
  verifyUbArtifact(check.artifact)
}

/** 缺失或修改过的原始证据统一失败，不尝试恢复为成功状态。 */
function verifyUbArtifact(artifact: UbArtifact | undefined): void {
  ubRequire(artifact && typeof artifact.path === 'string', 'UB_MODE_INVALID')
  ubRequire(
    ubArtifact(artifact.path).sha256 === artifact.sha256,
    'UB_MODE_ARTIFACT_CHANGED',
  )
}

/** 从本机记录核对指定最终提交，供 pre-push 与 PR 共用。 */
export function verifyUbCommit(root: string, revision: string): UbReceipt {
  const head = ubGit(root, ['rev-parse', '--verify', `${revision}^{commit}`])
  const directory = ubReceiptDirectory(root, head)
  ubRequire(!existsSync(resolve(directory, 'running.lock')), 'UB_MODE_RUNNING')
  const path = resolve(directory, 'receipt.json')
  let content: string
  try {
    content = readFileSync(path, 'utf8')
  } catch {
    throw new Error('[UB_MODE_MISSING] 请先对最终提交执行 npm run ub:check')
  }
  const receipt = validateUbReceipt(
    JSON.parse(content) as unknown,
    head,
    ubGit(root, ['rev-parse', `${head}^{tree}`]),
    ubSkill(root),
    Date.now(),
  )
  requireUbBase(root, receipt.base, head)
  return receipt
}
