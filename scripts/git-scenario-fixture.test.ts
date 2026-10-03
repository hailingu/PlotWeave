/** 夹具复用必须节约播种工作，同时保留独立 Git 对象、索引、引用与工作树。 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { expect, it } from 'vitest'
import { gitScenarioFixture } from './git-scenario-fixture'

/** 只在测试创建的仓库运行 Git，不继承宿主钩子的定位变量。 */
function git(root: string, args: string[], input?: string): string {
  const env = { ...process.env }
  for (const key of [
    'GIT_DIR',
    'GIT_WORK_TREE',
    'GIT_INDEX_FILE',
    'GIT_PREFIX',
  ]) {
    delete env[key]
  }
  return execFileSync('git', args, {
    cwd: root,
    env,
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
