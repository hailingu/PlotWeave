import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { check, format, resolveConfig } from 'prettier'
import { afterEach, describe, expect, it } from 'vitest'

const repositoryRoot = resolve(import.meta.dirname, '..')
const temporaryDirectories: string[] = []

/** 构造一段明确不符合仓库风格（双引号 + 分号 + 松散空格）的 TypeScript 输入。 */
const badlyFormatted = 'const title  =  "PlotWeave" ;\nexport default title\n'

function makeTempFile(content: string): string {
  const directory = mkdtempSync(resolve(tmpdir(), 'plotweave-prettier-'))
  temporaryDirectories.push(directory)
  const filePath = resolve(directory, 'input.ts')
  writeFileSync(filePath, content)
  return filePath
}

/** Prettier 按文件路径向上查找配置，目录本身拿不到解析结果。 */
function resolveRepoConfig(): Promise<
  Awaited<ReturnType<typeof resolveConfig>>
> {
  return resolveConfig(resolve(repositoryRoot, 'index.html'))
}

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    rmSync(temporaryDirectories.pop()!, { recursive: true, force: true })
  }
})

describe('Prettier 格式化入口（issue #99 验收标准）', () => {
  it('package.json 暴露 format / format:check 脚本且指向 prettier', () => {
    const manifest = JSON.parse(
      readFileSync(resolve(repositoryRoot, 'package.json'), 'utf8'),
    ) as { scripts: Record<string, string> }

    expect(manifest.scripts.format).toContain('prettier --write')
    expect(manifest.scripts['format:check']).toContain('prettier --check')
  })

  it('非修改检查对不合格式输入返回失败，应用格式后复查通过', async () => {
    const config = (await resolveRepoConfig()) ?? {}
    expect(config.singleQuote).toBe(true)
    expect(config.semi).toBe(false)

    expect(
      await check(badlyFormatted, { ...config, parser: 'typescript' }),
    ).toBe(false)
    const formatted = await format(badlyFormatted, {
      ...config,
      parser: 'typescript',
    })
    expect(formatted).not.toBe(badlyFormatted)
    expect(await check(formatted, { ...config, parser: 'typescript' })).toBe(
      true,
    )
  })

  it('CLI 非修改检查以非零退出码报告问题', () => {
    const filePath = makeTempFile(badlyFormatted)
    const configPath = resolve(repositoryRoot, '.prettierrc.json')
    let exitStatus: number | null = null

    try {
      execFileSync(
        'npx',
        ['prettier', '--check', '--config', configPath, filePath],
        { cwd: repositoryRoot, stdio: 'pipe' },
      )
    } catch (error) {
      exitStatus = (error as { status?: number }).status ?? null
    }

    expect(exitStatus).not.toBeNull()
    expect(exitStatus).not.toBe(0)
  })

  it('格式化是幂等的：重复应用不产生新的差异', async () => {
    const config = (await resolveRepoConfig()) ?? {}
    const options = { ...config, parser: 'typescript' as const }
    const once = await format(badlyFormatted, options)

    expect(await format(once, options)).toBe(once)
  })
})
