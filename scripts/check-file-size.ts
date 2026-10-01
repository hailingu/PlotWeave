/** 静态执行维护源码的文件行数上限与有界祖父条款（issue #432，方案 B）。 */
import { execFileSync } from 'node:child_process'
import { lstatSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/** 只识别当前维护的源码语言；新增语言须同步 Scope Routing 与此清单。 */
function sourceLimit(path: string): number | undefined {
  if (
    !/^(src|src-tauri|scripts)\/.+\.(ts|tsx|js|mjs|cjs|css|rs|sh)$/s.test(path)
  ) {
    return undefined
  }
  return /\.test\.tsx?$/.test(path) ? 1800 : 800
}

/** JSON 基线必须是对象，不能让数组或 null 被视为有效政策。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 从当前门禁脚本旁读取版本化上限；禁止为新违规自动生成豁免。 */
function readBaseline(): Map<string, number> {
  const value: unknown = JSON.parse(
    readFileSync(
      resolve(import.meta.dirname, 'file-size-baseline.json'),
      'utf8',
    ),
  )
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.files)) {
    throw new Error('基线必须包含 version: 1 和 files 路径上限对象')
  }
  const baseline = new Map<string, number>()
  for (const [path, count] of Object.entries(value.files)) {
    const limit = sourceLimit(path)
    const canonical = path
      .split('/')
      .every((part) => part !== '' && part !== '.' && part !== '..')
    if (
      !canonical ||
      limit === undefined ||
      typeof count !== 'number' ||
      !Number.isSafeInteger(count) ||
      count <= limit
    ) {
      throw new Error(`无效的祖父条款路径或上限：${JSON.stringify(path)}`)
    }
    baseline.set(path, count)
  }
  return baseline
}

/** Git NUL 枚举同时包含已跟踪和未忽略的新文件，不按换行切文件名。 */
function sourcePaths(): string[] {
  const output = execFileSync(
    'git',
    [
      'ls-files',
      '-z',
      '--cached',
      '--others',
      '--exclude-standard',
      '--',
      'src',
      'src-tauri',
      'scripts',
    ],
    { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 },
  )
  return [
    ...new Set(
      output.split('\0').filter((path) => sourceLimit(path) !== undefined),
    ),
  ].sort()
}

/** 与 wc -l 同口径计算 LF；删除路径可跳过，其他读取失败必须阻止检查。 */
function physicalLines(path: string): number | undefined {
  let stat
  try {
    stat = lstatSync(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
  if (!stat.isFile())
    throw new Error(`源码不是普通文件：${JSON.stringify(path)}`)
  let lines = 0
  for (const byte of readFileSync(path)) {
    if (byte === 10) lines++
  }
  return lines
}

/** 对工作树执行只读检查，逐项报告遗留超限与违规；任一违规返回失败。 */
function main(): void {
  const baseline = readBaseline()
  let failed = false
  let checked = 0
  for (const path of sourcePaths()) {
    const lines = physicalLines(path)
    const cap = sourceLimit(path)
    if (lines === undefined || cap === undefined) continue
    checked++
    const limit = baseline.get(path) ?? cap
    if (lines > limit) {
      console.error(
        JSON.stringify({ code: 'SIZE_LIMIT_EXCEEDED', path, lines, limit }),
      )
      failed = true
    } else if (lines > cap) {
      console.log(
        JSON.stringify({ code: 'SIZE_GRANDFATHERED', path, lines, limit }),
      )
    }
  }
  console.log(
    JSON.stringify({ code: 'SIZE_CHECK_COMPLETE', checked, passed: !failed }),
  )
  process.exitCode = failed ? 1 : 0
}

try {
  main()
} catch (error) {
  console.error(
    JSON.stringify({
      code: 'SIZE_INPUT_ERROR',
      message: error instanceof Error ? error.message : String(error),
    }),
  )
  process.exitCode = 1
}
