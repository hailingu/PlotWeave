/**
 * 推送门禁范围 CLI：`node scripts/gate-scope.ts --base <rev> --head <rev>`。
 * 读取 base..head 的实际变更路径，输出 gate-scope-core 的分类结果；Git
 * 失败或参数缺失以非零退出，调用方 fail-closed。纯分类逻辑在同名
 * core 模块，便于 Vitest 直接覆盖。
 */
import { execFileSync } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { classifyChangedPaths } from './gate-scope-core.ts'

function parseArguments(
  argv: readonly string[],
): { base: string; head: string } | null {
  let base: string | undefined
  let head: string | undefined
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--base' && argv[index + 1] !== undefined) {
      base = argv[index + 1]
      index += 1
    } else if (argument === '--head' && argv[index + 1] !== undefined) {
      head = argv[index + 1]
      index += 1
    } else {
      return null
    }
  }
  return base !== undefined && head !== undefined ? { base, head } : null
}

function main(argv: readonly string[]): number {
  const parsed = parseArguments(argv)
  if (parsed === null) {
    process.stderr.write(
      '用法：node scripts/gate-scope.ts --base <rev> --head <rev>\n',
    )
    return 2
  }
  try {
    const output = execFileSync(
      'git',
      ['diff', '--no-renames', '--name-only', parsed.base, parsed.head],
      { encoding: 'utf8' },
    )
    const paths = output.split('\n').filter((line) => line !== '')
    process.stdout.write(`${classifyChangedPaths(paths)}\n`)
    return 0
  } catch (error) {
    process.stderr.write(
      `gate-scope：无法读取 ${parsed.base}..${parsed.head} 的变更：${
        error instanceof Error ? error.message : String(error)
      }\n`,
    )
    return 2
  }
}

// 仅在被 node 直接执行时进入 CLI；Vitest 导入模块不触发。
const entry = process.argv[1]
if (
  entry !== undefined &&
  realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url))
) {
  process.exitCode = main(process.argv.slice(2))
}
