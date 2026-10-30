/** #941：正式发布入口。verify 服务 Git hook，run 执行技能，pr 核对远端后建 draft。 */
import { execFileSync } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { ubGit, ubRequire, verifyUbCommit } from './ub-mode-evidence.ts'
import { runUbMode } from './ub-mode-run.ts'

/** 本地 PR 入口只接受标题与正文文件，不能通过透传参数改 head/base 或跳过 draft。 */
function createPr(root: string, title: string, bodyFile: string): void {
  const head = ubGit(root, ['rev-parse', 'HEAD'])
  verifyUbCommit(root, head)
  const branch = ubGit(root, ['symbolic-ref', '--short', 'HEAD'])
  ubRequire(!['dev', 'main'].includes(branch), 'UB_MODE_PROTECTED_BRANCH')
  const remote = ubGit(root, [
    'ls-remote',
    '--exit-code',
    'origin',
    `refs/heads/${branch}`,
  ]).split(/\s+/)[0]
  ubRequire(remote === head, 'UB_MODE_REMOTE_MISMATCH')
  execFileSync(
    'gh',
    [
      'pr',
      'create',
      '--repo',
      'hailingu/PlotWeave',
      '--base',
      'dev',
      '--head',
      branch,
      '--draft',
      '--title',
      title,
      '--body-file',
      bodyFile,
    ],
    { cwd: root, stdio: 'inherit' },
  )
}

/** 参数数目固定；未识别的调用一律失败。 */
export function ubGate(args: string[], cwd: string): void {
  const root = ubGit(cwd, ['rev-parse', '--show-toplevel'])
  const [command, first, second] = args
  ubRequire(
    first && args.length === (command === 'verify' ? 2 : 3),
    'UB_MODE_USAGE',
  )
  switch (command) {
    case 'verify':
      verifyUbCommit(root, first)
      process.stdout.write(`[UB_MODE_VERIFIED] ${first}\n`)
      return
    case 'run':
      ubRequire(second, 'UB_MODE_USAGE')
      runUbMode(root, first, second)
      return
    case 'pr':
      ubRequire(second, 'UB_MODE_USAGE')
      createPr(root, first, second)
      return
    default:
      throw new Error(
        '[UB_MODE_USAGE] run <base> <committed-review.json> | verify <commit> | pr <title> <body-file>',
      )
  }
}

const entry = process.argv[1]
if (
  entry &&
  realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url))
) {
  try {
    ubGate(process.argv.slice(2), process.cwd())
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    )
    process.exitCode = 1
  }
}
