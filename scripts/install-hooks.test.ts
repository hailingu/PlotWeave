/** issue #725：克隆态钩子接线契约——npm prepare 生命周期自动安装版本化 Git 钩子。 */
import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { afterAll, afterEach, expect, it } from 'vitest'
import {
  gitFixtureEnvironment,
  gitScenarioFixture,
} from './git-scenario-fixture'

const repositoryRoot = resolve(import.meta.dirname, '..')
const installerSource = resolve(import.meta.dirname, 'install-hooks.mjs')
const manifest = JSON.parse(
  readFileSync(resolve(repositoryRoot, 'package.json'), 'utf8'),
) as { scripts: Record<string, string> }
const temporaryDirectories: string[] = []

/** 隔离的真实空 Git 检出；安装器以自身位置定位仓库根，无需播种提交。 */
const clones = gitScenarioFixture((root) => {
  const result = spawnSync('git', ['init', '-q'], {
    cwd: root,
    encoding: 'utf8',
    env: gitFixtureEnvironment(),
  })
  expect(result.status).toBe(0)
})

afterAll(() => {
  clones.dispose()
})

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

/** 安装器副本落在场景根的 scripts/ 下，其根定位即该场景根。 */
function installScenarioCopy(root: string): string {
  mkdirSync(resolve(root, 'scripts'), { recursive: true })
  const copy = resolve(root, 'scripts', 'install-hooks.mjs')
  copyFileSync(installerSource, copy)
  return copy
}

/** 以受控环境运行安装器副本；不传 CI 时显式删除，保证非 CI 路径确定性。 */
function runInstaller(copy: string, root: string, ci?: string) {
  const env = gitFixtureEnvironment()
  if (ci === undefined) delete env.CI
  else env.CI = ci
  return spawnSync(process.execPath, [copy], {
    cwd: root,
    encoding: 'utf8',
    env,
  })
}

/** 读取场景根的 core.hooksPath；未设置时 git 退出码非零，不做成功断言。 */
function readHooksPath(root: string) {
  return spawnSync('git', ['config', 'core.hooksPath'], {
    cwd: root,
    encoding: 'utf8',
    env: gitFixtureEnvironment(),
  })
}

it('package.json 的 prepare 生命周期与 hooks:install 共用同一接线入口（issue #725）', () => {
  // 命令契约（issue #725 验收）：本地 npm install 经 prepare 自动接线；
  // hooks:install 保持为手动兜底入口，指向同一实现避免分叉。
  expect(manifest.scripts.prepare).toBe('node scripts/install-hooks.mjs')
  expect(manifest.scripts['hooks:install']).toBe(
    'node scripts/install-hooks.mjs',
  )
})

it('Git 检出内接线 core.hooksPath 且重复运行幂等（issue #725）', () => {
  const root = clones.create()
  const copy = installScenarioCopy(root)
  const first = runInstaller(copy, root)
  expect(first.status).toBe(0)
  expect(first.stdout).toContain('[HOOKS_INSTALLED]')
  expect(readHooksPath(root).stdout.trim()).toBe('.githooks')
  const second = runInstaller(copy, root)
  expect(second.status).toBe(0)
  expect(readHooksPath(root).stdout.trim()).toBe('.githooks')
})

it('CI 环境跳过接线且不改写检出配置（issue #725）', () => {
  const root = clones.create()
  const copy = installScenarioCopy(root)
  const result = runInstaller(copy, root, 'true')
  expect(result.status).toBe(0)
  expect(result.stdout).toContain('[HOOKS_INSTALL_SKIPPED]')
  expect(readHooksPath(root).status).not.toBe(0)
})

it('非 Git 目录跳过接线且不阻断 npm install（issue #725）', () => {
  const root = mkdtempSync(resolve(tmpdir(), 'plotweave-no-git-'))
  temporaryDirectories.push(root)
  const copy = installScenarioCopy(root)
  const result = runInstaller(copy, root)
  expect(result.status).toBe(0)
  expect(result.stdout).toContain('[HOOKS_INSTALL_SKIPPED]')
})

it('git config 写失败时醒目告警且不阻断 npm install（issue #725）', () => {
  const root = clones.create()
  const copy = installScenarioCopy(root)
  const shimDirectory = resolve(root, 'bin')
  mkdirSync(shimDirectory)
  const shim = resolve(shimDirectory, 'git')
  writeFileSync(
    shim,
    String.raw`#!/bin/sh
if [ "$1" = "config" ]; then
  exit 1
fi
exec /usr/bin/git "$@"
`,
  )
  chmodSync(shim, 0o755)
  const result = spawnSync(process.execPath, [copy], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...gitFixtureEnvironment(),
      PATH: `${shimDirectory}:${process.env.PATH}`,
    },
  })
  expect(result.status).toBe(0)
  expect(result.stderr).toContain('[HOOKS_INSTALL_FAILED]')
  expect(result.stdout).not.toContain('[HOOKS_INSTALLED]')
})
