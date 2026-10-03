/** 门禁探针只观察真实 Git 根与失败透传，不承担完整流水线检查。 */
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { expect, it } from 'vitest'
import {
  gitFixtureEnvironment,
  gitScenarioFixture,
} from './git-scenario-fixture'
import { writeGateRoutingProbe } from './gate-routing-probe'

/** 仅在测试私有仓库执行 Git，不启用宿主钩子。 */
function git(root: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd: root,
    env: gitFixtureEnvironment(),
    encoding: 'utf8',
  }).trim()
}

it.each(['OK', 'ERROR'])(
  '门禁探针观察指定根的真实索引，结果为 %s 时只在成功后记录',
  (qualityGateStatus) => {
    const fixture = gitScenarioFixture((root) => {
      git(root, ['init', '-q', '-b', 'main'])
      git(root, [
        '-c',
        'core.hooksPath=/dev/null',
        '-c',
        'user.name=probe-test',
        '-c',
        'user.email=probe@test',
        'commit',
        '-q',
        '--allow-empty',
        '-m',
        'seed',
      ])
    })
    try {
      const root = fixture.create()
      const caller = fixture.create()
      writeFileSync(resolve(root, 'story.txt'), 'selected root')
      git(root, ['add', 'story.txt'])
      const probe = resolve(root, 'probe.sh')
      const log = resolve(root, 'calls.log')
      const pending = resolve(root, 'pending.jsonl')
      writeGateRoutingProbe(probe)
      const result = spawnSync('sh', [probe], {
        cwd: caller,
        encoding: 'utf8',
        env: {
          ...gitFixtureEnvironment(),
          PLOTWEAVE_NODE_BIN: process.execPath,
          PLOTWEAVE_GATE_REPOSITORY_ROOT: root,
          PLOTWEAVE_GATE_PENDING_PATH: pending,
          PLOTWEAVE_TEST_LOG: log,
          PLOTWEAVE_TEST_QUALITY_GATE_STATUS: qualityGateStatus,
        },
      })
      const tree = git(root, ['write-tree'])
      expect(tree).not.toBe(git(caller, ['write-tree']))
      expect(readFileSync(log, 'utf8')).toContain(`analyzed-tree ${tree}\n`)
      expect(result.status, result.stderr).toBe(
        qualityGateStatus === 'OK' ? 0 : 1,
      )
      if (qualityGateStatus === 'OK') {
        expect(JSON.parse(readFileSync(pending, 'utf8'))).toEqual({
          tree,
          head: git(root, ['rev-parse', 'HEAD']),
          qualityGate: 'OK',
          newCodeUnresolvedIssues: 0,
        })
      } else {
        expect(existsSync(pending)).toBe(false)
      }
    } finally {
      fixture.dispose()
    }
  },
)
