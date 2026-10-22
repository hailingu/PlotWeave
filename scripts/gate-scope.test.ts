import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { classifyChangedPaths } from './gate-scope-core'
import { gitFixtureEnvironment } from './git-scenario-fixture'

const temporaryDirectories: string[] = []

afterAll(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('classifyChangedPaths', () => {
  it.each([
    [['docs/quality-assessment.md', 'README.md', 'AGENTS.md'], 'docs'],
    [['src/editor/App.tsx'], 'frontend'],
    [['src-tauri/src/lib.rs'], 'rust'],
    [['crates/plotweave-core/src/lib.rs'], 'rust'],
    [['native/macos/App/ShellStage.swift'], 'native'],
    [['docs/quality-assessment.md', 'src/App.tsx'], 'frontend'],
    [['docs/quality-assessment.md', 'src-tauri/src/lib.rs'], 'rust'],
    [
      ['docs/quality-assessment.md', 'native/macos/App/NativeHomeView.swift'],
      'native',
    ],
  ] as const)('%j → %s', (paths, expected) => {
    expect(classifyChangedPaths(paths)).toBe(expected)
  })

  it.each([
    [['src/App.tsx', 'src-tauri/src/lib.rs']],
    [['src/App.tsx', 'native/macos/App/ShellStage.swift']],
    [['scripts/gate-scope.ts']],
    [['.githooks/pre-push']],
    [['.github/workflows/ci.yml']],
    [['eslint.config.js']],
    [['package.json']],
    [['package-lock.json']],
    [['vite.native-canvas.config.ts']],
    [['native-canvas.html']],
    [['assets/icon.png']],
    [[]],
  ] as const)('%j → full（跨域/工具/未知/空集合）', (paths) => {
    expect(classifyChangedPaths(paths)).toBe('full')
  })

  it('删除路径与重命名路径同样参与分类', () => {
    expect(classifyChangedPaths(['src/editor/spine.ts', 'docs/old.md'])).toBe(
      'frontend',
    )
    expect(classifyChangedPaths(['native/macos/App/Removed.swift'])).toBe(
      'native',
    )
  })
})

describe('gate-scope CLI', () => {
  it('读取真实 base..head 变更并输出分类；参数缺失或 Git 失败时非零', () => {
    const root = mkdtempSync(resolve(tmpdir(), 'plotweave-gate-scope-'))
    temporaryDirectories.push(root)
    const git = (args: string[]) =>
      spawnSync('git', args, {
        cwd: root,
        encoding: 'utf8',
        env: gitFixtureEnvironment(),
      })
    expect(git(['init', '-q', '-b', 'main']).status).toBe(0)
    expect(git(['config', 'user.email', 'scope@test']).status).toBe(0)
    expect(git(['config', 'user.name', 'scope-test']).status).toBe(0)
    expect(git(['commit', '-q', '--allow-empty', '-m', 'seed']).status).toBe(0)
    writeFileSync(resolve(root, 'README.md'), 'assessment\n')
    expect(git(['add', 'README.md']).status).toBe(0)
    expect(git(['commit', '-q', '-m', 'docs']).status).toBe(0)

    const script = resolve(import.meta.dirname, 'gate-scope.ts')
    // Hooks in linked worktrees export GIT_DIR; the CLI must use the fixture too.
    const classify = spawnSync(
      process.execPath,
      [script, '--base', 'HEAD~1', '--head', 'HEAD'],
      { cwd: root, encoding: 'utf8', env: gitFixtureEnvironment() },
    )
    expect(classify.status, classify.stderr).toBe(0)
    expect(classify.stdout).toBe('docs\n')

    const missing = spawnSync(process.execPath, [script], {
      cwd: root,
      encoding: 'utf8',
      env: gitFixtureEnvironment(),
    })
    expect(missing.status).toBe(2)

    const badRevision = spawnSync(
      process.execPath,
      [script, '--base', 'no-such-rev', '--head', 'HEAD'],
      { cwd: root, encoding: 'utf8', env: gitFixtureEnvironment() },
    )
    expect(badRevision.status).toBe(2)
  })
})
