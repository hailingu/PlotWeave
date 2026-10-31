/** #941：通过真实 Git 对象及 CLI 验证发布记录边界，工具替身只用于故障注入。 */
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  cpSync,
  chmodSync,
  existsSync,
  readFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { afterEach, expect, it, vi } from 'vitest'
import { ubGate } from './ub-mode-gate'
import { gitFixtureEnvironment } from './git-scenario-fixture'

const roots: string[] = []
const script = resolve(import.meta.dirname, 'ub-mode-gate.ts')
// ub-mode-run.ts 经公开 run 入口在进程内驱动，真实 pre-push 子进程另验发布边界。
afterEach(() =>
  roots
    .splice(0)
    .forEach((root) => rmSync(root, { recursive: true, force: true })),
)
afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

/** 每例独占仓库、技能与命令，不继承真实发布服务或 Sonar 凭据。 */
function fixture() {
  const root = mkdtempSync(resolve(tmpdir(), 'plotweave-ub-'))
  roots.push(root)
  const env = {
    ...gitFixtureEnvironment(),
    PLOTWEAVE_UB_SKILL: resolve(root, 'SKILL.md'),
  }
  const git = (...args: string[]) =>
    spawnSync('git', args, { cwd: root, env, encoding: 'utf8' })
  for (const args of [
    ['init', '-q', '-b', 'dev'],
    ['config', 'user.name', 'test'],
    ['config', 'user.email', 'test@invalid'],
    ['config', 'core.hooksPath', '/dev/null'],
  ])
    expect(git(...args).status).toBe(0)
  writeFileSync(
    resolve(root, 'SKILL.md'),
    '---\nname: ub-mode\n---\nReal fixture skill\n',
  )
  writeFileSync(resolve(root, 'file.txt'), 'content\n')
  writeFileSync(resolve(root, '.gitignore'), 'calls.log\n.metrics/\nbin/\n')
  expect(git('add', '.').status).toBe(0)
  expect(git('commit', '-qm', 'seed').status).toBe(0)
  const run = (...args: string[]) => {
    vi.stubEnv('PLOTWEAVE_UB_SKILL', env.PLOTWEAVE_UB_SKILL)
    vi.stubEnv('PATH', env.PATH ?? '')
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    try {
      ubGate(args, root)
      return { status: 0, stderr: '' }
    } catch (error) {
      return { status: 1, stderr: String(error) }
    }
  }
  return { root, env, git, run }
}

/** 在新提交中加入需检查的生产源码和人工技能记录，命令使用受控故障边界。 */
function runnableFixture() {
  const f = fixture()
  expect(f.git('checkout', '-qb', 'feature/check').status).toBe(0)
  mkdirSync(resolve(f.root, 'src'))
  mkdirSync(resolve(f.root, 'bin'))
  writeFileSync(
    resolve(f.root, 'src/feature.ts'),
    'export const sum = (a: number, b: number) => a + b\n',
  )
  const review = Object.fromEntries(
    [
      'reviewer',
      'tdd',
      'rootCause',
      'model',
      'boundaries',
      'complexity',
      'duplication',
      'tests',
      'log',
      'unsupported',
    ].map((key) => [key, `Fixture manual review of ${key}`]),
  )
  writeFileSync(
    resolve(f.root, 'review.json'),
    JSON.stringify({ ...review, testCommand: 'npm test' }),
  )
  expect(f.git('add', '.').status).toBe(0)
  expect(f.git('commit', '-qm', 'feature').status).toBe(0)
  const command = (name: string, body = 'exit 0') => {
    const path = resolve(f.root, 'bin', name)
    writeFileSync(
      path,
      `#!/bin/sh\nprintf '%s\\n' '${name}' >> '${f.root}/calls.log'\n${body}\n`,
    )
    chmodSync(path, 0o755)
  }
  for (const name of ['npm', 'crapper', 'dryer', 'mutator', 'gh']) command(name)
  f.env.PATH = `${resolve(f.root, 'bin')}:${process.env.PATH}`
  const receipt = resolve(
    f.root,
    '.git/plotweave-ub-mode',
    f.git('rev-parse', 'HEAD').stdout.trim(),
    'receipt.json',
  )
  return { ...f, command, receipt }
}

it('缺失最终提交的 ub-mode 证据不能通过发布检查', () => {
  const f = fixture()
  const result = f.run('verify', 'HEAD')
  expect(result.status).not.toBe(0)
  expect(result.stderr).toContain('UB_MODE_MISSING')
  expect(
    spawnSync(process.execPath, [script, 'verify', 'HEAD'], {
      cwd: f.root,
      env: f.env,
      encoding: 'utf8',
    }).stderr,
  ).toContain('UB_MODE_MISSING')
})

it('真实 pre-push 在文档分流之前阻断缺失 ub-mode 证据', () => {
  const f = fixture()
  const base = f.git('rev-parse', 'HEAD').stdout.trim()
  writeFileSync(resolve(f.root, 'README.md'), '# docs\n')
  expect(f.git('add', '.').status).toBe(0)
  expect(f.git('commit', '-qm', 'docs').status).toBe(0)
  mkdirSync(resolve(f.root, '.githooks'))
  mkdirSync(resolve(f.root, 'scripts'))
  cpSync(
    resolve(import.meta.dirname, '../.githooks/pre-push'),
    resolve(f.root, '.githooks/pre-push'),
  )
  for (const file of [
    'ub-mode-gate.ts',
    'ub-mode-evidence.ts',
    'ub-mode-run.ts',
    'gate-scope.ts',
    'gate-scope-core.ts',
    'check-docs.sh',
  ]) {
    const copy = spawnSync('cp', [
      resolve(import.meta.dirname, file),
      resolve(f.root, 'scripts', file),
    ])
    expect(copy.status).toBe(0)
  }
  const head = f.git('rev-parse', 'HEAD').stdout.trim()
  const result = spawnSync('sh', ['.githooks/pre-push'], {
    cwd: f.root,
    env: { ...f.env, PLOTWEAVE_NODE_BIN: process.execPath },
    encoding: 'utf8',
    input: `refs/heads/topic ${head} refs/heads/topic ${base}\n`,
  })
  expect(result.status).not.toBe(0)
  expect(result.stderr).toContain('UB_MODE_MISSING')
})

it('真实 pre-push 接受有效记录，唯一对象只检查一次，删除 ref 不查', () => {
  const f = runnableFixture()
  mkdirSync(resolve(f.root, '.githooks'))
  mkdirSync(resolve(f.root, 'scripts'))
  cpSync(
    resolve(import.meta.dirname, '../.githooks/pre-push'),
    resolve(f.root, '.githooks/pre-push'),
  )
  for (const file of [
    'ub-mode-gate.ts',
    'ub-mode-evidence.ts',
    'ub-mode-run.ts',
    'gate-scope.ts',
    'gate-scope-core.ts',
    'check-docs.sh',
  ])
    cpSync(resolve(import.meta.dirname, file), resolve(f.root, 'scripts', file))
  const gatePath = resolve(f.root, 'scripts/sonar-quality-gate.sh')
  writeFileSync(gatePath, '#!/bin/sh\necho sonar >> calls.log\n')
  chmodSync(gatePath, 0o755)
  expect(f.git('add', '.').status).toBe(0)
  expect(f.git('commit', '-qm', 'real hook tooling').status).toBe(0)
  expect(f.run('run', 'dev', 'review.json').status).toBe(0)
  const head = f.git('rev-parse', 'HEAD').stdout.trim()
  const zero = '0'.repeat(40)
  const result = spawnSync('sh', ['.githooks/pre-push'], {
    cwd: f.root,
    env: { ...f.env, PLOTWEAVE_NODE_BIN: process.execPath },
    encoding: 'utf8',
    input: `refs/heads/topic ${head} refs/heads/topic ${zero}\nrefs/tags/tip ${head} refs/tags/tip ${zero}\n(delete) ${zero} refs/heads/old ${head}\n`,
  })
  expect(result.status, result.stderr).toBe(0)
  expect(result.stdout.match(/UB_MODE_VERIFIED/g)).toHaveLength(1)
  expect(
    readFileSync(resolve(f.root, 'calls.log'), 'utf8').match(/sonar/g),
  ).toHaveLength(1)
})

it('实际运行四项命令后通过，后续新提交必须重检', () => {
  const f = runnableFixture()
  expect(f.run('run', 'dev', 'review.json').status).toBe(0)
  expect(
    readFileSync(resolve(f.root, 'calls.log'), 'utf8').trim().split('\n'),
  ).toEqual(['npm', 'crapper', 'dryer', 'mutator'])
  expect(f.run('verify', 'HEAD').status).toBe(0)
  writeFileSync(resolve(f.root, 'file.txt'), 'changed\n')
  expect(f.git('add', '.').status).toBe(0)
  expect(f.git('commit', '-qm', 'next').status).toBe(0)
  expect(f.run('verify', 'HEAD').stderr).toContain('UB_MODE_MISSING')
})

it.each(['npm', 'crapper', 'dryer', 'mutator'])(
  '检查失败不保留旧成功记录：%s',
  (tool) => {
    const f = runnableFixture()
    expect(f.run('run', 'dev', 'review.json').status).toBe(0)
    f.command(tool, 'exit 3')
    expect(f.run('run', 'dev', 'review.json').stderr).toContain(
      'UB_MODE_CHECK_FAILED',
    )
    expect(existsSync(f.receipt)).toBe(false)
  },
)

it('dryer 成功退出但发现重复也不能发布', () => {
  const f = runnableFixture()
  f.command('dryer', 'echo "DUPLICATE score=0.85"')
  expect(f.run('run', 'dev', 'review.json').stderr).toContain(
    'UB_MODE_DUPLICATION',
  )
  expect(existsSync(f.receipt)).toBe(false)
})

it('脏工作树及检查期间源码修改均不能生成记录', () => {
  const f = runnableFixture()
  writeFileSync(resolve(f.root, 'file.txt'), 'dirty')
  expect(f.run('run', 'dev', 'review.json').stderr).toContain('UB_MODE_DIRTY')
  expect(f.git('restore', 'file.txt').status).toBe(0)
  f.command('mutator', 'echo dirty > file.txt')
  expect(f.run('run', 'dev', 'review.json').stderr).toContain('UB_MODE_DIRTY')
  expect(existsSync(f.receipt)).toBe(false)
})

it('检查后的技能和日志字节修改使证据失效', () => {
  const f = runnableFixture()
  expect(f.run('run', 'dev', 'review.json').status).toBe(0)
  const value = JSON.parse(readFileSync(f.receipt, 'utf8')) as {
    checks: { artifact: { path: string } }[]
  }
  writeFileSync(value.checks[0]!.artifact.path, 'different')
  expect(f.run('verify', 'HEAD').stderr).toContain('UB_MODE_ARTIFACT_CHANGED')
  expect(f.run('run', 'dev', 'review.json').status).toBe(0)
  writeFileSync(
    resolve(f.root, 'SKILL.md'),
    '---\nname: ub-mode\n---\nChanged skill body\n',
  )
  expect(f.run('verify', 'HEAD').stderr).toContain('UB_MODE_SKILL_CHANGED')
})

it('PR 只为已检查且与真实 origin head 一致的分支创建 draft', () => {
  const f = runnableFixture()
  const origin = `${f.root}-origin.git`
  roots.push(origin)
  expect(
    spawnSync('git', ['clone', '--bare', f.root, origin], { env: f.env })
      .status,
  ).toBe(0)
  expect(f.git('remote', 'add', 'origin', origin).status).toBe(0)
  expect(f.run('pr', 'title', '/tmp/body.md').stderr).toContain(
    'UB_MODE_MISSING',
  )
  expect(f.run('run', 'dev', 'review.json').status).toBe(0)
  f.command('gh', `printf '%s\\n' "$*" >> '${f.root}/calls.log'`)
  expect(f.run('pr', 'title', '/tmp/body.md').status).toBe(0)
  expect(readFileSync(resolve(f.root, 'calls.log'), 'utf8')).toContain(
    '--base dev --head feature/check --draft',
  )
  expect(
    f.git(
      '--git-dir',
      origin,
      'update-ref',
      'refs/heads/feature/check',
      f.git('rev-parse', 'dev').stdout.trim(),
    ).status,
  ).toBe(0)
  expect(f.run('pr', 'title', '/tmp/body.md').stderr).toContain(
    'UB_MODE_REMOTE_MISMATCH',
  )
})

it('纯文档或工具不支持语言仅保存明确人工检查，仍运行覆盖率', () => {
  const f = runnableFixture()
  expect(f.git('rm', 'src/feature.ts').status).toBe(0)
  expect(f.git('commit', '-qm', 'docs only').status).toBe(0)
  expect(f.run('run', 'dev', 'review.json').status).toBe(0)
  const directory = resolve(
    f.root,
    '.git/plotweave-ub-mode',
    f.git('rev-parse', 'HEAD').stdout.trim(),
  )
  const receipt = JSON.parse(
    readFileSync(resolve(directory, 'receipt.json'), 'utf8'),
  ) as { checks: { mode: string }[] }
  expect(receipt.checks.map((check) => check.mode)).toEqual([
    'tool',
    'manual',
    'manual',
    'manual',
  ])
  expect(f.run('verify', 'HEAD').status).toBe(0)
})

it('伴随工具缺失可按技能人工降级，已安装工具失败仍阻断', () => {
  const f = runnableFixture()
  const path = resolve(f.root, 'review.json')
  const review = JSON.parse(readFileSync(path, 'utf8')) as Record<
    string,
    unknown
  >
  writeFileSync(
    path,
    JSON.stringify({
      ...review,
      fallbacks: {
        complexity: 'Manually counted branches and tested each transition',
      },
    }),
  )
  expect(f.git('add', '.').status).toBe(0)
  expect(f.git('commit', '-qm', 'review fallback').status).toBe(0)
  rmSync(resolve(f.root, 'bin/crapper'))
  f.env.PATH = `${resolve(f.root, 'bin')}:/usr/bin:/bin`
  expect(f.run('run', 'dev', 'review.json').status).toBe(0)
  expect(f.run('verify', 'HEAD').status).toBe(0)
  f.command('crapper', 'exit 2')
  expect(f.run('run', 'dev', 'review.json').stderr).toContain(
    'UB_MODE_CHECK_FAILED',
  )
})

it('同一提交并发执行被互斥，运行中记录不可用于发布', () => {
  const f = runnableFixture()
  expect(f.run('run', 'dev', 'review.json').status).toBe(0)
  const lock = resolve(f.receipt, '../running.lock')
  mkdirSync(lock)
  expect(f.run('run', 'dev', 'review.json').stderr).toContain('UB_MODE_RUNNING')
  expect(f.run('verify', 'HEAD').stderr).toContain('UB_MODE_RUNNING')
  rmSync(lock, { recursive: true })
  expect(f.run('verify', 'HEAD').status).toBe(0)
})

it('参数不完整、未知命令及技能缺失不能调用发布', () => {
  const f = runnableFixture()
  expect(f.run('pr').stderr).toContain('UB_MODE_USAGE')
  expect(f.run('unknown', 'a', 'b').stderr).toContain('UB_MODE_USAGE')
  f.env.PLOTWEAVE_UB_SKILL = resolve(f.root, 'missing.md')
  expect(f.run('run', 'dev', 'review.json').stderr).toContain(
    'UB_MODE_SKILL_MISSING',
  )
})

it('人工审查记录缺项阻断且不保留成功记录', () => {
  const f = runnableFixture()
  writeFileSync(resolve(f.root, 'review.json'), '{}')
  expect(f.git('add', '.').status).toBe(0)
  expect(f.git('commit', '-qm', 'incomplete review').status).toBe(0)
  expect(f.run('run', 'dev', 'review.json').stderr).toContain(
    'UB_MODE_REVIEW_INCOMPLETE',
  )
})

it('生产文件名称含 Probe 或 fixture 仍必须进入伴随工具检查', () => {
  const f = runnableFixture()
  mkdirSync(resolve(f.root, 'scripts'))
  writeFileSync(
    resolve(f.root, 'src/feature.test.ts'),
    'export const testOnly = true\n',
  )
  writeFileSync(
    resolve(f.root, 'scripts/pre-push-scenario-fixture.ts'),
    'export const fixtureOnly = true\n',
  )
  for (const name of ['modelProbe.ts', 'fixtureLoader.ts'])
    writeFileSync(resolve(f.root, 'src', name), 'export const loaded = true\n')
  expect(f.git('add', '.').status).toBe(0)
  expect(f.git('commit', '-qm', 'production loaders').status).toBe(0)
  expect(f.run('run', 'dev', 'review.json').status).toBe(0)
  const path = resolve(
    f.root,
    '.git/plotweave-ub-mode',
    f.git('rev-parse', 'HEAD').stdout.trim(),
    'receipt.json',
  )
  const receipt = JSON.parse(readFileSync(path, 'utf8')) as {
    checks: { command: string[] }[]
  }
  for (const check of receipt.checks.slice(1)) {
    expect(check.command).toContain('src/modelProbe.ts')
    expect(check.command).toContain('src/fixtureLoader.ts')
    expect(check.command).not.toContain('src/feature.test.ts')
    expect(check.command).not.toContain('scripts/pre-push-scenario-fixture.ts')
  }
})

it('发布验证拒绝多余参数，真实覆盖率命令的第一个参数是 run', () => {
  const f = runnableFixture()
  f.command('npm', '[ "$1" = run ] || exit 64')
  expect(f.run('run', 'dev', 'review.json').status).toBe(0)
  expect(f.run('verify', 'HEAD', 'extra').stderr).toContain('UB_MODE_USAGE')
  expect(f.run('verify', '').stderr).toContain('UB_MODE_USAGE')
})

it.each([false, 0, '', null, ['text']])(
  '人工降级结构必须是字段映射：%j',
  (fallbacks) => {
    const f = runnableFixture()
    const path = resolve(f.root, 'review.json')
    const review = JSON.parse(readFileSync(path, 'utf8')) as Record<
      string,
      unknown
    >
    writeFileSync(path, JSON.stringify({ ...review, fallbacks }))
    expect(f.git('add', '.').status).toBe(0)
    expect(f.git('commit', '-qm', 'invalid fallback shape').status).toBe(0)
    expect(f.run('run', 'dev', 'review.json').stderr).toContain(
      'UB_MODE_REVIEW_INCOMPLETE',
    )
  },
)

it.each(['required', 'fallback'])(
  '审查文字拒绝空白并允许单字符名称：%s',
  (mode) => {
    const f = runnableFixture()
    const path = resolve(f.root, 'review.json')
    const review = JSON.parse(readFileSync(path, 'utf8')) as Record<
      string,
      unknown
    >
    const save = (value: Record<string, unknown>) => {
      writeFileSync(path, JSON.stringify(value))
      expect(f.git('add', '.').status).toBe(0)
      expect(f.git('commit', '-qm', 'review text boundary').status).toBe(0)
    }
    save({ ...review, reviewer: '顾', fallbacks: { complexity: '无' } })
    expect(f.run('run', 'dev', 'review.json').status).toBe(0)
    save({
      ...review,
      ...(mode === 'required'
        ? { tdd: '  ' }
        : { fallbacks: { complexity: '  ' } }),
    })
    expect(f.run('run', 'dev', 'review.json').stderr).toContain(
      'UB_MODE_REVIEW_INCOMPLETE',
    )
  },
)

it('非文字的人工降级结论不能当作真实审查证据', () => {
  const f = runnableFixture()
  const path = resolve(f.root, 'review.json')
  const review = JSON.parse(readFileSync(path, 'utf8')) as Record<
    string,
    unknown
  >
  writeFileSync(
    path,
    JSON.stringify({ ...review, fallbacks: { complexity: true } }),
  )
  expect(f.git('add', '.').status).toBe(0)
  expect(f.git('commit', '-qm', 'invalid manual record').status).toBe(0)
  rmSync(resolve(f.root, 'bin/crapper'))
  f.env.PATH = `${resolve(f.root, 'bin')}:/usr/bin:/bin`
  expect(f.run('run', 'dev', 'review.json').stderr).toContain(
    'UB_MODE_REVIEW_INCOMPLETE',
  )
})

it('显式仓库不受调用方 Git 定位变量影响', () => {
  const f = runnableFixture()
  vi.stubEnv('GIT_DIR', resolve(f.root, 'unrelated.git'))
  vi.stubEnv('GIT_WORK_TREE', resolve(f.root, 'other-worktree'))
  vi.stubEnv('GIT_INDEX_FILE', resolve(f.root, 'other-index'))
  expect(f.run('run', 'dev', 'review.json').status).toBe(0)
  expect(f.run('verify', 'HEAD').status).toBe(0)
})

it('执行和发布校验都拒绝缩小到任务自身提交的基线', () => {
  const f = runnableFixture()
  expect(f.run('run', 'HEAD', 'review.json').stderr).toContain(
    'UB_MODE_BASE_MISMATCH',
  )
  expect(existsSync(f.receipt)).toBe(false)
  expect(f.run('run', 'dev', 'review.json').status).toBe(0)
  const receipt = JSON.parse(readFileSync(f.receipt, 'utf8')) as Record<
    string,
    unknown
  >
  writeFileSync(
    f.receipt,
    JSON.stringify({
      ...receipt,
      base: f.git('rev-parse', 'HEAD').stdout.trim(),
    }),
  )
  expect(f.run('verify', 'HEAD').stderr).toContain('UB_MODE_BASE_MISMATCH')
})

it('变异执行必须重跑全部候选，不以缓存或未覆盖候选的跳过结果放行', () => {
  const f = runnableFixture()
  f.command(
    'mutator',
    'case " $* " in *" --mutate-all "*) ;; *) exit 64 ;; esac\ncase " $* " in *" --no-coverage "*) ;; *) exit 64 ;; esac',
  )
  expect(f.run('run', 'dev', 'review.json').status).toBe(0)
})

it.each([undefined, '', '1', '2'])(
  '技能命令遵循既有 CPU 预算且缺省为4：%j',
  (budget) => {
    const f = runnableFixture()
    vi.stubEnv('PLOTWEAVE_GATE_CPU_BUDGET', budget)
    const expected = budget || '4'
    f.command(
      'npm',
      `case " $* " in *" --maxWorkers=${expected} "*) ;; *) exit 64 ;; esac`,
    )
    f.command(
      'mutator',
      `case " $* " in *" --max-workers ${expected} "*) ;; *) exit 64 ;; esac`,
    )
    expect(f.run('run', 'dev', 'review.json').status).toBe(0)
  },
)

it.each(['0', '-1', '1.5', 'text', '9007199254740992'])(
  '非法 CPU 预算阻断而不静默回退：%s',
  (budget) => {
    const f = runnableFixture()
    vi.stubEnv('PLOTWEAVE_GATE_CPU_BUDGET', budget)
    expect(f.run('run', 'dev', 'review.json').stderr).toContain(
      'GATE_CPU_BUDGET_INVALID',
    )
    expect(existsSync(f.receipt)).toBe(false)
  },
)
