/** 静态执行维护源码的文件行数上限与有界祖父条款（issue #432，方案 B）。 */
import { execFileSync } from 'node:child_process'
import { Buffer } from 'node:buffer'
import { lstatSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/** 每个路径分别保留工作树与索引测量，避免一份内容替另一份放行。 */
type SourceMeasurement = {
  path: string
  lines: number | undefined
  tree: 'worktree' | 'index'
}

/** 有效索引里的普通文件，路径绑定不可变 blob 对象。 */
type IndexedFile = { path: string; object: string }

/** Git 批量协议的已验证头；长度用于按字节分帧，不按内容换行拆分。 */
type BlobHeader = { object: string; size: number; bytes: Buffer }

/** 提交树中拥有祖父条款的政策文件；缺失时不提供任何索引豁免。 */
const baselinePath = 'scripts/file-size-baseline.json'

/** 规则文本（AGENTS.md）按目录界定维护范围，不限定后缀；枚举路径必须三分类。 */
const maintainedPattern = /^(src|src-tauri|scripts)\//s

/** 已知维护源码后缀；新增语言须同步 Scope Routing 与此清单。 */
const sourceSuffixes = new Set([
  'ts',
  'tsx',
  'js',
  'mjs',
  'cjs',
  'css',
  'rs',
  'sh',
])

/** 显式登记的非维护源码后缀（issue #466）：图标位图、平台清单、配置与锁文件；新类别须先扩表再入库。 */
const excludedSuffixes = new Set([
  'png',
  'icns',
  'ico',
  'xml',
  'json',
  'toml',
  'lock',
])

/** 受枚举路径的处置：测量、有意排除，或未分类；未分类必须 fail-closed。 */
type PathClass =
  | { kind: 'source'; limit: number }
  | { kind: 'excluded' }
  | { kind: 'unclassified' }

/** 后缀取基名内最后一个点之后的部分；无后缀与隐藏文件名不会命中源码清单。 */
function pathSuffix(path: string): string {
  const dot = path.lastIndexOf('.')
  return dot > path.lastIndexOf('/') ? path.slice(dot + 1) : ''
}

/** 目录范围外不参与（枚举已限定三棵树）；范围内按后缀三分类。 */
function classifyPath(path: string): PathClass {
  if (!maintainedPattern.test(path)) return { kind: 'excluded' }
  const suffix = pathSuffix(path)
  if (sourceSuffixes.has(suffix)) {
    return { kind: 'source', limit: /\.test\.tsx?$/.test(path) ? 1800 : 800 }
  }
  return excludedSuffixes.has(suffix)
    ? { kind: 'excluded' }
    : { kind: 'unclassified' }
}

/** 未分类路径按原始字节诊断；无法无损解码的名字以十六进制呈现。 */
function displayPath(encoded: string): string {
  const bytes = Buffer.from(encoded, 'latin1')
  const decoded = bytes.toString('utf8')
  return bytes.equals(Buffer.from(decoded)) ? decoded : bytes.toString('hex')
}

/** Git 路径先用 latin1 保留每个字节；源码必须无损转为现有 UTF-8 路径契约。 */
function decodeGitPath(encoded: string): string {
  const bytes = Buffer.from(encoded, 'latin1')
  const path = bytes.toString('utf8')
  if (!bytes.equals(Buffer.from(path))) {
    throw new Error(`源码路径不是有效 UTF-8：${bytes.toString('hex')}`)
  }
  return path
}

/** JSON 基线必须是对象，不能让数组或 null 被视为有效政策。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 从当前门禁脚本旁读取版本化上限；禁止为新违规自动生成豁免。 */
function readBaseline(): Map<string, number> {
  return parseBaseline(
    readFileSync(
      resolve(import.meta.dirname, 'file-size-baseline.json'),
      'utf8',
    ),
  )
}

/** 当前政策与提交政策共用结构校验，不能把已修复的工作副本当成索引政策。 */
function parseBaseline(content: string): Map<string, number> {
  const value: unknown = JSON.parse(content)
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.files)) {
    throw new Error('基线必须包含 version: 1 和 files 路径上限对象')
  }
  const baseline = new Map<string, number>()
  for (const [path, count] of Object.entries(value.files)) {
    const classified = classifyPath(path)
    const canonical = path
      .split('/')
      .every((part) => part !== '' && part !== '.' && part !== '..')
    if (
      !canonical ||
      classified.kind !== 'source' ||
      typeof count !== 'number' ||
      !Number.isSafeInteger(count) ||
      count <= classified.limit
    ) {
      throw new Error(`无效的祖父条款路径或上限：${JSON.stringify(path)}`)
    }
    baseline.set(path, count)
  }
  return baseline
}

/** 工作树枚举的三分类结果；源码经 UTF-8 校验，排除与未分类只登记呈现名。 */
type WorkingDiscovery = {
  sources: string[]
  excluded: Set<string>
  unclassified: Set<string>
}

/** Git NUL 枚举同时包含已跟踪和未忽略的新文件，不按换行切文件名。 */
function workingPaths(): WorkingDiscovery {
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
    { encoding: 'latin1', maxBuffer: 10 * 1024 * 1024 },
  )
  const discovery: WorkingDiscovery = {
    sources: [],
    excluded: new Set(),
    unclassified: new Set(),
  }
  for (const encoded of new Set(output.split('\0').filter(Boolean))) {
    const classified = classifyPath(encoded)
    if (classified.kind === 'source')
      discovery.sources.push(decodeGitPath(encoded))
    else discovery[classified.kind].add(displayPath(encoded))
  }
  discovery.sources.sort()
  return discovery
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
  return countLines(readFileSync(path))
}

/** 文件和 Git blob 共用 LF 字节口径，不依赖文本编码或 checkout 转换。 */
function countLines(content: Uint8Array): number {
  let lines = 0
  for (const byte of content) {
    if (byte === 10) lines++
  }
  return lines
}

/** 有效索引的三分类结果；源码与基线绑定不可变 blob 对象。 */
type IndexDiscovery = {
  files: IndexedFile[]
  excluded: Set<string>
  unclassified: Set<string>
}

/** 一次枚举 Git 有效索引（含 GIT_INDEX_FILE），同时绑定源码与基线对象。 */
function indexedFiles(): IndexDiscovery {
  const output = execFileSync(
    'git',
    ['ls-files', '--stage', '-z', '--', 'src', 'src-tauri', 'scripts'],
    { encoding: 'latin1', maxBuffer: 10 * 1024 * 1024 },
  )
  const discovery: IndexDiscovery = {
    files: [],
    excluded: new Set(),
    unclassified: new Set(),
  }
  for (const record of output.split('\0').filter(Boolean)) {
    const separator = record.indexOf('\t')
    if (separator < 0) throw new Error('无法解析 Git 索引记录')
    const encoded = record.slice(separator + 1)
    const classified = classifyPath(encoded)
    if (encoded !== baselinePath && classified.kind !== 'source') {
      discovery[classified.kind].add(displayPath(encoded))
      continue
    }
    const path = decodeGitPath(encoded)
    const [mode, object, stage] = record.slice(0, separator).split(' ')
    if (
      stage !== '0' ||
      (mode !== '100644' && mode !== '100755') ||
      object === undefined
    ) {
      throw new Error(
        `源码或基线索引不是已合并的普通文件：${JSON.stringify(path)}`,
      )
    }
    discovery.files.push({ path, object })
  }
  return discovery
}

/** 先批量校验对象类型和长度，为完整读取计算缓冲区，不新增总字节上限。 */
function blobHeaders(objects: string[], input: string): BlobHeader[] {
  const records = execFileSync('git', ['cat-file', '--batch-check'], {
    input,
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
  })
    .trimEnd()
    .split('\n')
  if (records.length !== objects.length)
    throw new Error('Git 对象批量响应不完整')
  return objects.map((expected, index) => {
    const record = records[index] ?? ''
    const [object, type, count] = record.split(' ')
    const size = Number(count)
    if (
      object !== expected ||
      type !== 'blob' ||
      !Number.isSafeInteger(size) ||
      size < 0
    ) {
      throw new Error(`无法读取索引 blob：${expected}`)
    }
    return { object: expected, size, bytes: Buffer.from(`${record}\n`) }
  })
}

/** 批量读取去重后的原始 blob，验证字节分帧；避免每个源码启动一个 Git。 */
function indexedBlobs(files: IndexedFile[]): Map<string, Buffer> {
  const objects = [...new Set(files.map(({ object }) => object))]
  if (objects.length === 0) return new Map()
  const input = `${objects.join('\n')}\n`
  const headers = blobHeaders(objects, input)
  const bytes = headers.reduce(
    (total, header) => total + header.bytes.length + header.size + 1,
    0,
  )
  if (!Number.isSafeInteger(bytes))
    throw new Error('Git 对象批量长度无法安全表示')
  const output = execFileSync('git', ['cat-file', '--batch'], {
    input,
    maxBuffer: bytes,
  })
  const blobs = new Map<string, Buffer>()
  let offset = 0
  for (const header of headers) {
    const start = offset + header.bytes.length
    const end = start + header.size
    if (
      !output.subarray(offset, start).equals(header.bytes) ||
      output[end] !== 10
    ) {
      throw new Error('Git 对象批量内容分帧无效')
    }
    blobs.set(header.object, output.subarray(start, end))
    offset = end + 1
  }
  if (offset !== output.length) throw new Error('Git 对象批量内容长度不一致')
  return blobs
}

/** 缺失对象是读取失败，不能把不完整输入替换为空文件。 */
function indexedBlob(blobs: Map<string, Buffer>, object: string): Buffer {
  const blob = blobs.get(object)
  if (blob === undefined) throw new Error(`索引对象缺少内容：${object}`)
  return blob
}

/** 索引没有基线时只执行普通硬上限；有基线则必须解析其原始已暂存内容。 */
function indexedBaseline(
  files: IndexedFile[],
  blobs: Map<string, Buffer>,
): Map<string, number> {
  const file = files.find(({ path }) => path === baselinePath)
  return file === undefined
    ? new Map()
    : parseBaseline(indexedBlob(blobs, file.object).toString('utf8'))
}

/** 工作树发现新文件；索引保证暂存版本不能被未暂存修复或删除掩盖。 */
function* sourceMeasurements(
  working: WorkingDiscovery,
  index: IndexDiscovery,
  blobs: Map<string, Buffer>,
): Generator<SourceMeasurement> {
  for (const path of working.sources) {
    yield { path, lines: physicalLines(path), tree: 'worktree' }
  }
  for (const { path, object } of index.files) {
    if (path === baselinePath) continue
    yield { path, lines: countLines(indexedBlob(blobs, object)), tree: 'index' }
  }
}

/** 对两份源码执行只读检查，逐项报告来源；违规、未分类或读取失败均为失败。 */
function main(): void {
  const baseline = readBaseline()
  const index = indexedFiles()
  const blobs = indexedBlobs(index.files)
  const committedBaseline = indexedBaseline(index.files, blobs)
  const working = workingPaths()
  const excluded = new Set([...working.excluded, ...index.excluded])
  const unclassified = new Set([...working.unclassified, ...index.unclassified])
  let failed = false
  const checked = new Set<string>()
  for (const { path, lines, tree } of sourceMeasurements(
    working,
    index,
    blobs,
  )) {
    const classified = classifyPath(path)
    if (lines === undefined || classified.kind !== 'source') continue
    checked.add(path)
    const currentLimit = baseline.get(path) ?? classified.limit
    const limit =
      tree === 'index'
        ? Math.min(
            currentLimit,
            committedBaseline.get(path) ?? classified.limit,
          )
        : currentLimit
    if (lines > limit) {
      console.error(
        JSON.stringify({
          code: 'SIZE_LIMIT_EXCEEDED',
          path,
          lines,
          limit,
          tree,
        }),
      )
      failed = true
    } else if (lines > classified.limit) {
      console.log(
        JSON.stringify({
          code: 'SIZE_GRANDFATHERED',
          path,
          lines,
          limit,
          tree,
        }),
      )
    }
  }
  for (const path of [...unclassified].sort()) {
    console.error(JSON.stringify({ code: 'SIZE_UNCLASSIFIED_FILE', path }))
    failed = true
  }
  console.log(
    JSON.stringify({
      code: 'SIZE_CHECK_COMPLETE',
      checked: checked.size,
      excluded: excluded.size,
      passed: !failed,
    }),
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
