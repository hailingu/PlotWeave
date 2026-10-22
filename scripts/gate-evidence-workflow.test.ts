/** #593：解析真实 CI 配置并在隔离 Git 历史中执行 job 的 shell 入口。
 * base 核验器与工具链是执行输入，PR head 只提供待核验 Git 对象。 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import {
  gitFixtureEnvironment,
  gitScenarioFixture,
} from './git-scenario-fixture'

/** 复用锁文件中 ESLint 的 YAML 解析器；按配置语义读取，不匹配布局或措辞。 */
const { load } = createRequire(import.meta.url)('js-yaml') as {
  load: (source: string) => Workflow
}
type Step = {
  uses?: string
  with?: Record<string, unknown>
  run?: string
  env?: Record<string, string>
}
type Workflow = { jobs: Record<string, { name: string; steps: Step[] }> }
const repositoryRoot = resolve(import.meta.dirname, '..')
const verifierPath = 'scripts/verify-gate-evidence.ts'
const ledgerPath = 'docs/development/gate-history.jsonl'
// 2026-10-22 owner-approved bootstrap contract: exact immutable source objects.
const bootstrapBase = 'fbd298ebe6cfa1a9fab6e632c00cdede06d81faf'
const bootstrapVerifier = '4e17c1c198aa8150c87473849d61e92692083777'
const workflow = load(
  readFileSync(resolve(repositoryRoot, '.github/workflows/ci.yml'), 'utf8'),
)
const job = workflow.jobs['gate-evidence']!
const environment = gitFixtureEnvironment()
const fixtures: Array<ReturnType<typeof gitScenarioFixture>> = []

/** 只操作测试私有 Git；不继承宿主提交钩子或仓库定位。 */
function git(root: string, ...args: string[]): string {
  const result = spawnSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], {
    cwd: root,
    env: environment,
    encoding: 'utf8',
  })
  if (result.status !== 0) throw new Error(result.stderr)
  return result.stdout.trim()
}

function write(root: string, path: string, content: string): void {
  const target = resolve(root, path)
  mkdirSync(resolve(target, '..'), { recursive: true })
  writeFileSync(target, content)
}

function commit(root: string, message: string): string {
  git(root, 'add', '-A')
  git(root, 'commit', '-qm', message)
  return git(root, 'rev-parse', 'HEAD')
}

/** PR 含两次内容提交，使非 tip 缺证必须失败；可选择物化真实 tree 记录。 */
function scenario(evidenced = false, missingBase = false) {
  let base = ''
  let head = ''
  const fixture = gitScenarioFixture((root) => {
    git(root, 'init', '-q', '-b', 'dev')
    git(root, 'config', 'user.name', 'gate-workflow-test')
    git(root, 'config', 'user.email', 'gate@example.invalid')
    const ledger = `${JSON.stringify({ tree: 'f'.repeat(40), qualityGate: 'OK', newCodeUnresolvedIssues: 0 })}\n`
    write(root, ledgerPath, ledger)
    write(root, '.nvmrc', '24.18.0\n')
    if (!missingBase)
      write(
        root,
        verifierPath,
        readFileSync(resolve(repositoryRoot, verifierPath), 'utf8'),
      )
    base = commit(root, 'base')
    git(root, 'remote', 'add', 'origin', root)
    git(root, 'update-ref', 'refs/remotes/origin/dev', base)
    write(
      root,
      verifierPath,
      "import {writeFileSync} from 'node:fs'; writeFileSync('pr-executed', 'unsafe'); process.exit(0)\n",
    )
    write(root, '.nvmrc', '0\n')
    const first = commit(root, 'PR replaces verifier and runtime')
    write(root, 'story.txt', 'latest content\n')
    if (evidenced)
      write(
        root,
        ledgerPath,
        ledger +
          `${JSON.stringify({ tree: git(root, 'rev-parse', `${first}^{tree}`), qualityGate: 'OK', newCodeUnresolvedIssues: 0 })}\n`,
      )
    head = commit(root, 'PR tip')
  })
  fixtures.push(fixture)
  return { root: fixture.create(), base, head }
}

/** 模拟 checkout 的 ref 选择，随后执行真实 YAML 中的 run 步骤。
 * GitHub 表达式只替换固定的事件提交值；不运行本地伪造的工作流。 */
function runJob(scene: ReturnType<typeof scenario>, releaseBoundary = false) {
  const checkout = job.steps.find((step) =>
    step.uses?.startsWith('actions/checkout@'),
  )!
  const checkoutRef =
    checkout.with?.ref === '${{ github.event.pull_request.base.sha }}'
      ? scene.base
      : scene.head
  git(scene.root, 'checkout', '--detach', checkoutRef)
  const source = job.steps
    .flatMap((step) => (step.run ? [step.run] : []))
    .join('\n')
    .replaceAll('${{ github.event.pull_request.base.ref }}', 'dev')
    .replaceAll('${{ github.event.pull_request.head.sha }}', scene.head)
  const runnerTemp = resolve(scene.root, '.runner-temp')
  mkdirSync(runnerTemp, { recursive: true })
  const result = spawnSync('bash', ['-e', '-o', 'pipefail', '-c', source], {
    cwd: scene.root,
    encoding: 'utf8',
    env: {
      ...environment,
      BASE_SHA: scene.base,
      HEAD_SHA: scene.head,
      RELEASE_BOUNDARY: releaseBoundary ? '1' : '',
      RUNNER_TEMP: runnerTemp,
    },
  })
  return { status: result.status, output: result.stdout + result.stderr }
}

/** Import only immutable approved history into a private repository, then create an untrusted PR. */
function bootstrapScenario(evidenced = false, trustedObject = true) {
  let head = ''
  const fixture = gitScenarioFixture((root) => {
    git(root, 'init', '-q', '-b', 'dev')
    git(root, 'config', 'user.name', 'gate-bootstrap-test')
    git(root, 'config', 'user.email', 'bootstrap@example.invalid')
    git(root, 'fetch', '--no-tags', repositoryRoot, bootstrapBase)
    if (trustedObject)
      git(root, 'fetch', '--no-tags', repositoryRoot, bootstrapVerifier)
    git(root, 'checkout', '--detach', bootstrapBase)
    git(root, 'remote', 'add', 'origin', root)
    const ledger = readFileSync(resolve(root, ledgerPath), 'utf8')
    write(
      root,
      verifierPath,
      "import {writeFileSync} from 'node:fs'; writeFileSync('pr-executed', 'unsafe'); process.exit(0)\n",
    )
    const first = commit(root, 'untrusted PR replaces verifier')
    write(root, 'story.txt', 'latest content\n')
    if (evidenced)
      write(
        root,
        ledgerPath,
        ledger +
          `${JSON.stringify({ tree: git(root, 'rev-parse', `${first}^{tree}`), qualityGate: 'OK', newCodeUnresolvedIssues: 0 })}\n`,
      )
    head = commit(root, 'PR tip')
  })
  fixtures.push(fixture)
  return { root: fixture.create(), base: bootstrapBase, head }
}

afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.dispose()
})

it('required job 固定 checkout base SHA，保持检查名和只读工具链来源', () => {
  const frontendCheckout = workflow.jobs.frontend!.steps.find((step) =>
    step.uses?.startsWith('actions/checkout@'),
  )!
  expect(frontendCheckout.with?.['fetch-depth']).toBe(0)
  const checkout = job.steps.find((step) =>
    step.uses?.startsWith('actions/checkout@'),
  )!
  expect(job.name).toBe('gate-evidence（门禁证据核验）')
  expect(checkout.with?.ref).toBe('${{ github.event.pull_request.base.sha }}')
  expect(checkout.with?.['fetch-depth']).toBe(0)
  expect(checkout.with?.['persist-credentials']).toBe(false)
  const node = job.steps.find((step) =>
    step.uses?.startsWith('actions/setup-node@'),
  )!
  expect(node.with?.['node-version-file']).toBe('.nvmrc')
  const verify = job.steps.find((step) => step.env?.BASE_SHA !== undefined)!
  expect(verify.env?.BASE_SHA).toBe('${{ github.event.pull_request.base.sha }}')
  expect(verify.env?.HEAD_SHA).toBe('${{ github.event.pull_request.head.sha }}')
  // This machine expression is the approved same-repository release authorization contract.
  expect(verify.env?.RELEASE_BOUNDARY).toBe(
    "${{ github.event.pull_request.base.ref == 'main' && github.event.pull_request.head.ref == 'dev' && github.event.pull_request.head.repo.full_name == github.repository && '1' || '' }}",
  )
})

it('PR 替换核验器为 exit 0 仍不能中和非 tip 缺证，且不执行 PR 代码', () => {
  const scene = scenario()
  const result = runJob(scene)
  expect(result.status, result.output).toBe(1)
  expect(result.output).toContain('[GATE_EVIDENCE_MISSING]')
  expect(existsSync(resolve(scene.root, 'pr-executed'))).toBe(false)
  expect(readFileSync(resolve(scene.root, '.nvmrc'), 'utf8')).toBe('24.18.0\n')
})

it('正常 head 台账仍按原规则通过，tip 保留滞后诊断', () => {
  const scene = scenario(true)
  const result = runJob(scene)
  expect(result.status, result.output).toBe(0)
  expect(result.output).toContain('[GATE_EVIDENCE_TIP_LAG]')
  expect(existsSync(resolve(scene.root, 'pr-executed'))).toBe(false)
  expect(git(scene.root, 'rev-parse', 'HEAD')).toBe(scene.base)
})

it('base 缺少核验器时失败，不回退到 PR 替身', () => {
  const scene = scenario(false, true)
  const result = runJob(scene)
  expect(result.status).not.toBe(0)
  expect(existsSync(resolve(scene.root, 'pr-executed'))).toBe(false)
})

it('head 对象获取失败时 job 失败，不执行 PR 替身或改动 base 工作区', () => {
  const scene = scenario()
  const result = runJob({ ...scene, head: '0'.repeat(40) })
  expect(result.status).not.toBe(0)
  expect(existsSync(resolve(scene.root, 'pr-executed'))).toBe(false)
  expect(git(scene.root, 'rev-parse', 'HEAD')).toBe(scene.base)
})

it('approved old-main release uses the fixed verifier and validates an evidenced head', () => {
  const scene = bootstrapScenario(true)
  const result = runJob(scene, true)
  expect(result.status, result.output).toBe(0)
  expect(result.output).toContain('[GATE_EVIDENCE_TIP_LAG]')
  expect(existsSync(resolve(scene.root, 'pr-executed'))).toBe(false)
  expect(git(scene.root, 'rev-parse', 'HEAD')).toBe(bootstrapBase)
})

it('approved bootstrap still rejects missing non-tip evidence without running the head substitute', () => {
  const scene = bootstrapScenario()
  const result = runJob(scene, true)
  expect(result.status, result.output).toBe(1)
  expect(result.output).toContain('[GATE_EVIDENCE_MISSING]')
  expect(existsSync(resolve(scene.root, 'pr-executed'))).toBe(false)
})

it('old-main outside the repository release shape retains the missing-base failure', () => {
  const scene = bootstrapScenario(true)
  const result = runJob(scene)
  expect(result.status).not.toBe(0)
  expect(existsSync(resolve(scene.root, 'pr-executed'))).toBe(false)
})

it('a different base cannot opt into bootstrap merely by setting release-boundary', () => {
  const scene = scenario(true, true)
  const result = runJob(scene, true)
  expect(result.status).not.toBe(0)
  expect(existsSync(resolve(scene.root, 'pr-executed'))).toBe(false)
})

it('an unavailable fixed verifier fails without falling back to the PR substitute', () => {
  const scene = bootstrapScenario(true, false)
  const result = runJob(scene, true)
  expect(result.status).not.toBe(0)
  expect(existsSync(resolve(scene.root, 'pr-executed'))).toBe(false)
})
