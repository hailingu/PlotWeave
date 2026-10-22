/** 夹具复用必须节约播种工作，同时保留独立 Git 对象、索引、引用与工作树。 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { expect, it, vi } from 'vitest'
import {
  gitFixtureEnvironment,
  gitScenarioFixture,
} from './git-scenario-fixture'

it.each([
  { label: '无运行时配置', count: undefined, parameters: undefined },
  { label: 'COUNT 配置', count: '1', parameters: undefined },
  {
    label: '-c 参数与 COUNT 配置',
    count: '1',
    parameters: "'maintenance.auto=true' 'fixture.parameter=preserved'",
  },
])(
  '夹具保留继承配置并禁用提交后的自动维护：$label',
  ({ count, parameters }) => {
    vi.stubEnv('GIT_CONFIG_COUNT', count)
    vi.stubEnv('GIT_CONFIG_PARAMETERS', parameters)
    vi.stubEnv('GIT_CONFIG_KEY_0', 'fixture.inherited')
    vi.stubEnv('GIT_CONFIG_VALUE_0', 'preserved')
    const fixture = gitScenarioFixture((root) => {
      git(root, ['init', '-q', '-b', 'main'])
      git(root, ['config', 'maintenance.auto', 'true'])
    })
    try {
      const root = fixture.create()
      expect(git(root, ['config', '--get', 'maintenance.auto'])).toBe('false')
      if (count === '1') {
        expect(git(root, ['config', '--get', 'fixture.inherited'])).toBe(
          'preserved',
        )
      }
      if (parameters !== undefined) {
        expect(git(root, ['config', '--get', 'fixture.parameter'])).toBe(
          'preserved',
        )
      }
      expect(process.env.GIT_CONFIG_COUNT).toBe(count)
      expect(process.env.GIT_CONFIG_PARAMETERS).toBe(parameters)
    } finally {
      fixture.dispose()
      vi.unstubAllEnvs()
    }
  },
)

it('达到维护阈值的真实提交不启动异步维护，仓库可立即复制', () => {
  const fixture = gitScenarioFixture((root) => {
    git(root, ['init', '-q', '-b', 'main'])
    git(root, ['config', 'maintenance.auto', 'true'])
    const tracePath = resolve(root, 'trace.jsonl')
    execFileSync(
      'git',
      [
        '-c',
        'core.hooksPath=/dev/null',
        '-c',
        'user.name=fixture-test',
        '-c',
        'user.email=fixture@test',
        '-c',
        'maintenance.loose-objects.enabled=true',
        '-c',
        'maintenance.loose-objects.auto=1',
        'commit',
        '-q',
        '--allow-empty',
        '-m',
        'seed',
      ],
      {
        cwd: root,
        env: { ...gitFixtureEnvironment(), GIT_TRACE2_EVENT: tracePath },
      },
    )
    // Git Trace2 JSON 协议记录真实子进程；maintenance 是 Git 命令名。
    const events = readFileSync(tracePath, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    expect(
      events.filter(
        (event) =>
          event.event === 'child_start' && event.argv.includes('maintenance'),
      ),
    ).toEqual([])
    expect(existsSync(resolve(root, '.git/objects/maintenance.lock'))).toBe(
      false,
    )
  })
  try {
    const first = fixture.create()
    const second = fixture.create()
    expect(git(first, ['rev-parse', 'HEAD'])).toBe(
      git(second, ['rev-parse', 'HEAD']),
    )
    expect(git(second, ['fsck', '--no-dangling'])).toBe('')
  } finally {
    fixture.dispose()
  }
})

/** 只在测试创建的仓库运行 Git，不继承宿主钩子的定位变量。 */
function git(root: string, args: string[], input?: string): string {
  return execFileSync('git', args, {
    cwd: root,
    env: gitFixtureEnvironment(),
    input,
    encoding: 'utf8',
  }).trim()
}

it('多场景只播种一次；首个场景的提交、索引、引用和文件不污染后续副本', () => {
  let seedRuns = 0
  const fixture = gitScenarioFixture((root) => {
    seedRuns += 1
    git(root, ['init', '-q', '-b', 'main'])
    git(root, ['config', 'core.hooksPath', '/dev/null'])
    git(root, ['config', 'user.name', 'fixture-test'])
    git(root, ['config', 'user.email', 'fixture@test'])
    writeFileSync(resolve(root, 'story.txt'), 'seed')
    git(root, ['add', 'story.txt'])
    git(root, ['commit', '-q', '-m', 'seed'])
  })
  try {
    const first = fixture.create()
    const original = git(first, ['rev-parse', 'HEAD'])
    writeFileSync(resolve(first, 'story.txt'), 'first')
    git(first, ['add', 'story.txt'])
    git(first, ['commit', '-q', '-m', 'first'])
    const changed = git(first, ['rev-parse', 'HEAD'])
    git(first, ['branch', 'first-only'])
    writeFileSync(resolve(first, 'draft.txt'), 'untracked')
    const second = fixture.create()
    const third = fixture.create()
    // 这是夹具的工作量契约：多个真实场景不得重复创建同一初始历史。
    expect(seedRuns).toBe(1)
    for (const root of [second, third]) {
      expect(readFileSync(resolve(root, 'story.txt'), 'utf8')).toBe('seed')
      expect(existsSync(resolve(root, 'draft.txt'))).toBe(false)
      expect(git(root, ['status', '--porcelain'])).toBe('')
      expect(git(root, ['rev-parse', 'HEAD'])).toBe(original)
      expect(git(root, ['branch', '--list', 'first-only'])).toBe('')
      // Git 批量对象查询协议：原副本新创建的对象在其他副本中不存在。
      expect(git(root, ['cat-file', '--batch-check'], `${changed}\n`)).toBe(
        `${changed} missing`,
      )
    }
  } finally {
    fixture.dispose()
  }
})

it('播种失败不缓存半成品；重试重新播种，dispose 删除自己创建的目录', () => {
  const seeds: string[] = []
  const fixture = gitScenarioFixture((root) => {
    seeds.push(root)
    writeFileSync(resolve(root, 'seed.txt'), String(seeds.length))
    if (seeds.length === 1) throw new Error('seed failed')
  })
  try {
    expect(() => fixture.create()).toThrow('seed failed')
    expect(existsSync(seeds[0] ?? '')).toBe(false)
    const root = fixture.create()
    expect(seeds).toHaveLength(2)
    expect(readFileSync(resolve(root, 'seed.txt'), 'utf8')).toBe('2')
    fixture.dispose()
    expect(existsSync(root)).toBe(false)
    expect(existsSync(seeds[1] ?? '')).toBe(false)
  } finally {
    fixture.dispose()
  }
})
