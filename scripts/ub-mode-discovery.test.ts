/** #941：真实 Vitest 发现只消费维护的测试，不消费变异执行器的生成副本。 */
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { expect, it } from 'vitest'
import { ESLint } from 'eslint'
import { getFileInfo } from 'prettier'
import { gitFixtureEnvironment } from './git-scenario-fixture'

it('Vitest 保留正常测试并排除中断后残留的变异工作树测试', () => {
  const root = mkdtempSync(resolve(tmpdir(), 'plotweave-test-discovery-'))
  const repository = resolve(import.meta.dirname, '..')
  try {
    for (const path of [
      'src/kept.test.ts',
      'target/mutation-workers/interrupted/scripts/generated.test.ts',
      'target/mutator-backup/scripts/stale.test.ts',
    ]) {
      const file = resolve(root, path)
      mkdirSync(resolve(file, '..'), { recursive: true })
      writeFileSync(file, 'throw new Error("list-only fixture")\n')
    }
    const result = spawnSync(
      process.execPath,
      [
        resolve(repository, 'node_modules/vitest/vitest.mjs'),
        'list',
        '--filesOnly',
        '--root',
        root,
        '--config',
        resolve(repository, 'vite.config.ts'),
      ],
      { cwd: root, env: gitFixtureEnvironment(), encoding: 'utf8' },
    )
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('src/kept.test.ts')
    expect(result.stdout).not.toContain('generated.test.ts')
    expect(result.stdout).not.toContain('stale.test.ts')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

it('静态工具保留维护源码并排除变异生成副本', async () => {
  const repository = resolve(import.meta.dirname, '..')
  const lint = new ESLint({ cwd: repository })
  for (const directory of [
    'target/mutation-workers',
    'target/mutator-backup',
  ]) {
    const file = resolve(
      repository,
      directory,
      'synthetic/scripts/generated.ts',
    )
    expect(await lint.isPathIgnored(file)).toBe(true)
    expect(
      (
        await getFileInfo(file, {
          ignorePath: resolve(repository, '.prettierignore'),
        })
      ).ignored,
    ).toBe(true)
  }
  const maintained = resolve(repository, 'scripts/ub-mode-evidence.ts')
  expect(await lint.isPathIgnored(maintained)).toBe(false)
  expect(
    (
      await getFileInfo(maintained, {
        ignorePath: resolve(repository, '.prettierignore'),
      })
    ).ignored,
  ).toBe(false)
  const results = await lint.lintText('unexpectedGlobal()', {
    filePath: resolve(repository, 'scripts/future.mjs'),
  })
  expect(
    results
      .flatMap((result) => result.messages)
      .some((message) => message.ruleId === 'no-undef'),
  ).toBe(true)
})
