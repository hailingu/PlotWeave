/** #941：真实运行技能伴随检查，失败或内容变动不生成发布记录。 */
import { spawnSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync, renameSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  ubArtifact,
  ubGit,
  ubReceiptDirectory,
  ubRequire,
  ubSkill,
  requireUbBase,
  type UbCheck,
} from './ub-mode-evidence.ts'

/** 人工执行的技能部分；这些字段是审查记录而非机器证明。 */
interface UbReview {
  reviewer: string
  tdd: string
  rootCause: string
  model: string
  boundaries: string
  complexity: string
  duplication: string
  tests: string
  log: string
  testCommand: string
  unsupported: string
  fallbacks?: Record<string, string>
}

/** 检查期间的源码必须保持原样；产物只能写忽略目录与 common Git。 */
function requireClean(root: string): void {
  ubRequire(
    ubGit(root, ['status', '--porcelain', '--untracked-files=all']) === '',
    'UB_MODE_DIRTY',
  )
}

/** 人工结论必须从最终提交读取，避免检查记录引用未提交草稿。 */
function readReview(root: string, head: string, path: string): UbReview {
  const review = JSON.parse(ubGit(root, ['show', `${head}:${path}`])) as Record<
    string,
    unknown
  >
  for (const key of [
    'reviewer',
    'tdd',
    'rootCause',
    'model',
    'boundaries',
    'complexity',
    'duplication',
    'tests',
    'log',
    'testCommand',
    'unsupported',
  ]) {
    requireReviewText(review[key])
  }
  validateFallbacks(review.fallbacks)
  return review as unknown as UbReview
}

/** 必填审查和人工降级共享同一个非空文字约束，不接收布尔值代替审查。 */
function requireReviewText(value: unknown): void {
  ubRequire(
    typeof value === 'string' && value.trim().length > 0,
    'UB_MODE_REVIEW_INCOMPLETE',
  )
}

/** 可省略人工降级，但传入时必须是字段到审查文字的对象映射。 */
function validateFallbacks(value: unknown): void {
  if (value === undefined) return
  ubRequire(
    typeof value === 'object' && value !== null && !Array.isArray(value),
    'UB_MODE_REVIEW_INCOMPLETE',
  )
  for (const text of Object.values(value)) requireReviewText(text)
}

/** 只传明确路径；无受支持的源码时不能把空参数变成扫描全仓库。 */
function productionPaths(root: string, base: string, head: string): string[] {
  return ubGit(root, [
    'diff',
    '--no-renames',
    '--name-only',
    '-z',
    '--diff-filter=AM',
    base,
    head,
  ])
    .split('\0')
    .filter((path) => /\.(?:[cm]?[jt]sx?|rs|py)$/.test(path))
    .filter(
      (path) =>
        !/(?:\.(?:test|spec)(?:-d)?\.[cm]?[jt]sx?$|\/(?:tests?|fixtures)\/)/i.test(
          path,
        ) &&
        ![
          'scripts/pre-push-scenario-fixture.ts',
          'scripts/git-scenario-fixture.ts',
          'scripts/native-coverage-fixture.ts',
          'scripts/gate-routing-probe.ts',
        ].includes(path),
    )
}

/** 运行一项真实命令并保存退出码与输出；失败立即退出且不写 receipt。 */
function executeCheck(
  root: string,
  directory: string,
  name: string,
  command: string[],
  fallback: string | undefined,
): UbCheck {
  const executable = command[0]
  ubRequire(executable, 'UB_MODE_INVALID')
  const result = spawnSync(executable, command.slice(1), {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 33_554_432, // 32 MiB；这是固定日志预算，不是业务计算。
  })
  const artifactPath = resolve(directory, `${name}.log`)
  const missing =
    result.error && 'code' in result.error && result.error.code === 'ENOENT'
  if (missing && fallback && name !== 'coverage') {
    writeFileSync(
      artifactPath,
      `MANUAL: ${fallback}\nTool unavailable: ${executable}\n`,
    )
    return {
      name,
      mode: 'manual',
      command: ['manual', executable],
      artifact: ubArtifact(artifactPath),
    }
  }
  writeFileSync(
    artifactPath,
    JSON.stringify(
      {
        command,
        status: result.status,
        stdout: result.stdout,
        stderr: result.stderr,
        error: result.error?.message,
      },
      null,
      2,
    ),
  )
  ubRequire(result.status === 0, 'UB_MODE_CHECK_FAILED')
  if (name === 'duplication')
    ubRequire(
      !result.stdout.includes('DUPLICATE score='),
      'UB_MODE_DUPLICATION',
    )
  process.stdout.write(`[UB_MODE_CHECK_OK] ${name}\n`)
  return { name, mode: 'tool', command, artifact: ubArtifact(artifactPath) }
}

/** 工具未支持的语言和纯文档走真实人工审查，明确标注不能计算的指标。 */
function manualCheck(directory: string, name: string, text: string): UbCheck {
  const path = resolve(directory, `${name}.log`)
  writeFileSync(path, `MANUAL: ${text}\n`)
  return {
    name,
    mode: 'manual',
    command: ['manual', 'unsupported-language-or-no-runtime-change'],
    artifact: ubArtifact(path),
  }
}

/** 复用现有门禁的固定缺省及显式正整数预算，不更改检查集或阈值。 */
function cpuBudget(): string {
  const value = process.env.PLOTWEAVE_GATE_CPU_BUDGET || '4'
  ubRequire(
    /^\d+$/.test(value) &&
      Number.isSafeInteger(Number(value)) &&
      Number(value) > 0,
    'GATE_CPU_BUDGET_INVALID',
  )
  return value
}

/** 最终 HEAD 完成全部流程后原子发布记录；开始即撤销该 HEAD 的旧记录。 */
export function runUbMode(
  root: string,
  baseRevision: string,
  reviewPath: string,
): void {
  const head = ubGit(root, ['rev-parse', 'HEAD'])
  const directory = ubReceiptDirectory(root, head)
  mkdirSync(directory, { recursive: true })
  const lock = resolve(directory, 'running.lock')
  try {
    mkdirSync(lock)
  } catch {
    throw new Error(
      '[UB_MODE_RUNNING] 同一提交已有检查执行器；确认进程退出后才能恢复残留锁',
    )
  }
  try {
    runLocked(root, head, directory, baseRevision, reviewPath)
  } finally {
    rmSync(lock, { recursive: true })
  }
}

/** 同一提交只允许一个执行者改写产物，失败记录不能并发覆盖成功结论。 */
function runLocked(
  root: string,
  head: string,
  directory: string,
  baseRevision: string,
  reviewPath: string,
): void {
  const receiptPath = resolve(directory, 'receipt.json')
  rmSync(receiptPath, { force: true })
  const base = ubGit(root, [
    'rev-parse',
    '--verify',
    `${baseRevision}^{commit}`,
  ])
  requireUbBase(root, base, head)
  requireClean(root)
  const workers = cpuBudget()
  const skill = ubSkill(root)
  const review = readReview(root, head, reviewPath)
  const savedReview = resolve(directory, 'review.json')
  writeFileSync(savedReview, JSON.stringify(review, null, 2))
  const paths = productionPaths(root, base, head)
  const check = (name: string, command: string[]) =>
    executeCheck(root, directory, name, command, review.fallbacks?.[name])
  const checks: UbCheck[] = [
    check('coverage', [
      'npm',
      'run',
      'test:coverage',
      '--',
      `--maxWorkers=${workers}`,
    ]),
  ]
  const commands: [string, string[]][] = [
    [
      'complexity',
      ['crapper', '--use-existing-coverage', '--threshold', '9.99', ...paths],
    ],
    ['duplication', ['dryer', '--threshold', '0.8', ...paths]],
    [
      'mutation',
      [
        'mutator',
        '--mutate-all',
        '--no-coverage',
        '--test-command',
        review.testCommand,
        '--max-workers',
        workers,
        ...paths,
      ],
    ],
  ]
  for (const [name, command] of commands) {
    checks.push(
      paths.length
        ? check(name, command)
        : manualCheck(directory, name, review.unsupported),
    )
  }
  requireClean(root)
  ubRequire(
    ubGit(root, ['rev-parse', 'HEAD']) === head,
    'UB_MODE_OBJECT_MISMATCH',
  )
  ubRequire(ubSkill(root).sha256 === skill.sha256, 'UB_MODE_SKILL_CHANGED')
  const receipt = {
    version: 1,
    head,
    tree: ubGit(root, ['rev-parse', `${head}^{tree}`]),
    base,
    finishedAt: Date.now(),
    skill,
    review: ubArtifact(savedReview),
    checks,
  }
  const temporary = resolve(directory, `receipt.${process.pid}.tmp`)
  writeFileSync(temporary, JSON.stringify(receipt, null, 2))
  renameSync(temporary, receiptPath)
  process.stdout.write(`[UB_MODE_OK] ${head}\n`)
}
