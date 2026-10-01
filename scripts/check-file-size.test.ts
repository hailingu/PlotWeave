/** 行数静态检查器的行为契约：只使用临时 Git 仓库与生成夹具（issue #432）。 */
import { execFileSync, spawnSync } from 'node:child_process'
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { afterEach, expect, it } from 'vitest'

const repositoryRoot = resolve(import.meta.dirname, '..')
const directories: string[] = []

/** Git 钩子会向子进程传播定位变量；临时仓库必须独立于被测主工作树。 */
function environment(): NodeJS.ProcessEnv {
  const env = { ...process.env }
  for (const key of [
    'GIT_DIR',
    'GIT_WORK_TREE',
    'GIT_INDEX_FILE',
    'GIT_PREFIX',
    'PLOTWEAVE_NODE_BIN',
  ]) {
    delete env[key]
  }
  return env
}

/** 构造有真实 Git 枚举行为的隔离根目录，测试后删除。 */
function fixture(): string {
  const root = mkdtempSync(resolve(tmpdir(), 'plotweave-file-size-'))
  directories.push(root)
  const result = spawnSync('git', ['init', '-q', root], { env: environment() })
  if (result.status !== 0) throw new Error('临时 Git 仓库初始化失败')
  return root
}

/** 在临时仓库写入受控输入，返回绝对路径。 */
function write(root: string, path: string, content: string): string {
  const target = resolve(root, path)
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, content)
  return target
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

it.each(['untracked', 'staged'] as const)(
  '共享静态入口拒绝选定根目录中的 %s 超限版本（#432 / #405）',
  (state) => {
    // 若共享入口遗漏规模检查，三个外部 npm 子项成功后就会错误放行。
    const root = fixture()
    write(root, 'src/oversized.ts', '\n'.repeat(801))
    if (state === 'staged') {
      git(root, ['add', '--', 'src/oversized.ts'])
      write(root, 'src/oversized.ts', '\n'.repeat(800))
    }
    const npm = write(root, 'bin/npm', '#!/bin/sh\nexit 0\n')
    chmodSync(npm, 0o755)
    const result = spawnSync(
      'sh',
      [resolve(repositoryRoot, 'scripts/check-static.sh')],
      {
        cwd: root,
        encoding: 'utf8',
        env: {
          ...environment(),
          PLOTWEAVE_GATE_REPOSITORY_ROOT: root,
          PLOTWEAVE_NPM_BIN: npm,
        },
      },
    )
    expect(result.status).toBe(1)
    // 稳定诊断码契约见 docs/development/file-size-guard.md。
    expect(result.stderr).toContain('SIZE_LIMIT_EXCEEDED')
  },
)

/** 隔离 PATH，只保留真实 Git 与 dirname；Node 路径包含空格且没有默认别名。 */
function isolatedRuntime(root: string): { bin: string; node: string } {
  const bin = resolve(root, 'bin')
  mkdirSync(bin)
  for (const command of ['git', 'dirname']) {
    const executable = execFileSync('which', [command], {
      encoding: 'utf8',
    }).trim()
    symlinkSync(executable, resolve(bin, command))
  }
  const node = resolve(bin, 'selected node')
  symlinkSync(process.execPath, node)
  return { bin, node }
}

/** 运行真实共享入口；格式与类型工具已在路由检查覆盖，此处只隔离 npm 成本。 */
function runStaticWithRuntime(root: string, bin: string, node: string) {
  const npm = write(root, 'npm', '#!/bin/sh\nexit 0\n')
  chmodSync(npm, 0o755)
  return spawnSync(
    '/bin/sh',
    [resolve(repositoryRoot, 'scripts/check-static.sh')],
    {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...environment(),
        PATH: bin,
        PLOTWEAVE_GATE_REPOSITORY_ROOT: root,
        PLOTWEAVE_NPM_BIN: npm,
        PLOTWEAVE_NODE_BIN: node,
      },
    },
  )
}

it.each([
  [800, 0],
  [801, 1],
])('无默认 Node 时用指定运行时检查 %i 行源码', (lines, status) => {
  // 回归触发：硬编码 node 或未引用含空格的覆盖路径，均会错误退出 127。
  const root = fixture()
  const { bin, node } = isolatedRuntime(root)
  write(root, 'src/example.ts', '\n'.repeat(lines))
  const result = runStaticWithRuntime(root, bin, node)
  expect(result.status).toBe(status)
  expect(result[status === 0 ? 'stdout' : 'stderr']).toContain(
    status === 0 ? 'SIZE_CHECK_COMPLETE' : 'SIZE_LIMIT_EXCEEDED',
  )
})

it.each(['failure', 'missing'] as const)(
  '指定运行时 %s 时透传失败，即使默认 Node 可用也不回退',
  (mode) => {
    const root = fixture()
    const { bin } = isolatedRuntime(root)
    symlinkSync(process.execPath, resolve(bin, 'node'))
    const node = resolve(bin, 'configured node')
    if (mode === 'failure') {
      writeFileSync(node, '#!/bin/sh\nexit 23\n')
      chmodSync(node, 0o755)
    }
    const result = runStaticWithRuntime(root, bin, node)
    if (mode === 'failure') {
      expect(result.status, result.stderr).toBe(23)
    } else {
      // 缺失程序的退出码由宿主 shell 决定；契约是不回退、不放行。
      expect(result.status, result.stderr).not.toBe(0)
      expect(result.stderr).toContain(node)
    }
  },
)

/** 将真实检查器复制进沙箱；基线是夹具输入，不改动仓库政策文件。 */
function checkerFixture(files: Record<string, number> = {}): string {
  const root = fixture()
  write(
    root,
    'scripts/file-size-baseline.json',
    JSON.stringify({ version: 1, files }),
  )
  copyFileSync(
    resolve(repositoryRoot, 'scripts/check-file-size.ts'),
    resolve(root, 'scripts/check-file-size.ts'),
  )
  return root
}

/** 执行 CLI 并保留退出状态和 JSON 诊断，断言针对命令契约。 */
function runChecker(root: string, env: NodeJS.ProcessEnv = {}) {
  return spawnSync(
    process.execPath,
    [resolve(root, 'scripts/check-file-size.ts')],
    {
      cwd: root,
      encoding: 'utf8',
      env: { ...environment(), ...env },
    },
  )
}

it.each([
  ['src/example.ts', 800],
  ['src/view.tsx', 800],
  ['src/styles/example.css', 800],
  ['src-tauri/src/example.rs', 800],
  ['scripts/example.sh', 800],
  ['scripts/example.js', 800],
  ['scripts/example.mjs', 800],
  ['scripts/example.cjs', 800],
  ['src/example.test-d.ts', 800],
  ['src/example.test.ts', 1800],
  ['scripts/example.test.tsx', 1800],
] as const)('按文件类别拦截 %s 超限，修复后重新通过', (path, cap) => {
  // 少比较一次、错误分类测试后缀、缓存上次结果都会违反本行为。
  const root = checkerFixture()
  write(root, path, '\n'.repeat(cap))
  expect(runChecker(root).status).toBe(0)
  const content = '\n'.repeat(cap + 1)
  const target = write(root, path, content)
  const rejected = runChecker(root)
  expect(rejected.status).toBe(1)
  expect(rejected.stderr).toContain('SIZE_LIMIT_EXCEEDED')
  expect(readFileSync(target, 'utf8')).toBe(content)
  write(root, path, '\n'.repeat(cap))
  expect(runChecker(root).status).toBe(0)
})

it('计数遵从 wc -l：CRLF、注释、空行计入，末尾无 LF 的片段不额外计数', () => {
  const root = checkerFixture()
  write(
    root,
    'src/example.ts',
    '// comment\r\n'.repeat(400) + '\n'.repeat(400) + 'tail',
  )
  expect(runChecker(root).status).toBe(0)
  write(root, 'src/example.ts', '// comment\r\n'.repeat(400) + '\n'.repeat(401))
  expect(runChecker(root).status).toBe(1)
})

it('祖父条款允许保持或缩减既有超限文件，但不能增长或惠及新路径', () => {
  const root = checkerFixture({ 'src/legacy.ts': 900 })
  for (const lines of [900, 850]) {
    write(root, 'src/legacy.ts', '\n'.repeat(lines))
    const allowed = runChecker(root)
    expect(allowed.status).toBe(0)
    expect(allowed.stdout).toContain('SIZE_GRANDFATHERED')
  }
  write(root, 'src/legacy.ts', '\n'.repeat(901))
  expect(runChecker(root).status).toBe(1)
  write(root, 'src/legacy.ts', '\n'.repeat(800))
  expect(runChecker(root).stdout).not.toContain('SIZE_GRANDFATHERED')
  write(root, 'src/new.ts', '\n'.repeat(801))
  expect(runChecker(root).status).toBe(1)
})

it('Git 枚举覆盖带空格或换行的路径、暂存新增和被 ignore 匹配的跟踪文件', () => {
  const root = checkerFixture()
  const path = 'src/a space\nand newline.ts'
  write(root, path, '\n'.repeat(801))
  expect(runChecker(root).status).toBe(1)
  const staged = spawnSync('git', ['add', '--', path], {
    cwd: root,
    env: environment(),
  })
  expect(staged.status).toBe(0)
  write(root, '.gitignore', 'src/\n')
  expect(runChecker(root).status).toBe(1)
  rmSync(resolve(root, path))
  // 工作树删除不改变待提交的索引；只有暂存删除才排除该文件。
  expect(runChecker(root).status).toBe(1)
  git(root, ['rm', '--cached', '--', path])
  expect(runChecker(root).status).toBe(0)
})

/** 修改夹具的真实索引；显式环境覆盖模拟 Git 提供的有效提交索引。 */
function git(root: string, args: string[], env: NodeJS.ProcessEnv = {}) {
  return execFileSync('git', args, {
    cwd: root,
    env: { ...environment(), ...env },
    encoding: 'utf8',
  })
}

/** 真实 Git 索引可保存字节路径；夹具不依赖宿主文件系统能否创建该名称。 */
function indexBytePath(
  root: string,
  path: Buffer,
  env: NodeJS.ProcessEnv = {},
): void {
  const object = git(root, ['hash-object', '-w', '--stdin'], env).trim()
  // Git 的 -z --index-info 字节协议是夹具契约；不要求宿主能创建该文件名。
  execFileSync('git', ['update-index', '-z', '--index-info'], {
    cwd: root,
    env: { ...environment(), ...env },
    input: Buffer.concat([
      Buffer.from(`100644 ${object} 0\t`),
      path,
      Buffer.from([0]),
    ]),
  })
}

it.each([
  ['src/bad-', 'ff', '.ts'],
  ['src-tauri/src/bad-', 'c0af', '.rs'],
  ['scripts/bad-', 'e2', '.test.ts'],
])('有效索引的非 UTF-8 源码路径不能静默放行：%s%s%s', (prefix, hex, suffix) => {
  const root = checkerFixture()
  indexBytePath(
    root,
    Buffer.concat([
      Buffer.from(prefix),
      Buffer.from(hex, 'hex'),
      Buffer.from(suffix),
    ]),
  )
  const before = readFileSync(resolve(root, '.git/index'))
  const result = runChecker(root)
  expect(result.status).toBe(1)
  // SIZE_INPUT_ERROR 契约：无法完整表示的源码输入必须阻止检查。
  expect(JSON.parse(result.stderr.trim())).toMatchObject({
    code: 'SIZE_INPUT_ERROR',
  })
  expect(readFileSync(resolve(root, '.git/index'))).toEqual(before)
})

/** 注入工作树枚举的原始 NUL 协议，其他 Git 操作仍读写真实临时仓库。 */
function workingPathBytes(root: string, path: Buffer): NodeJS.ProcessEnv {
  const args = [
    'ls-files',
    '-z',
    '--cached',
    '--others',
    '--exclude-standard',
    '--',
    'src',
    'src-tauri',
    'scripts',
  ]
  const original = execFileSync('git', args, { cwd: root, env: environment() })
  const wire = write(root, 'path-output.bin', '')
  writeFileSync(wire, Buffer.concat([original, path, Buffer.from([0])]))
  const script = write(
    root,
    'bin/git.cjs',
    `
// 只替换工作树路径枚举的协议输入，其他命令保留真实 Git 行为。
const { readFileSync } = require('node:fs')
const { spawnSync } = require('node:child_process')
const args = process.argv.slice(2)
if (args[0] === 'ls-files' && args.includes('--others')) {
  process.stdout.write(readFileSync(process.env.PLOTWEAVE_PATH_BYTES))
} else {
  const result = spawnSync(process.env.PLOTWEAVE_PATH_GIT, args, { stdio: 'inherit' })
  process.exit(result.status ?? 1)
}
`,
  )
  const launcher = write(
    root,
    'bin/git',
    '#!/bin/sh\nexec "$PLOTWEAVE_PATH_NODE" "$PLOTWEAVE_PATH_SCRIPT" "$@"\n',
  )
  chmodSync(launcher, 0o755)
  return {
    PATH: `${resolve(root, 'bin')}:${process.env.PATH ?? ''}`,
    PLOTWEAVE_PATH_NODE: process.execPath,
    PLOTWEAVE_PATH_SCRIPT: script,
    PLOTWEAVE_PATH_BYTES: wire,
    PLOTWEAVE_PATH_GIT: execFileSync('which', ['git'], {
      encoding: 'utf8',
    }).trim(),
  }
}

it.each(['ff', 'c0af', 'e2'])(
  '工作树枚举不能把非 UTF-8 字节 %s 的源码路径当成删除或替代路径',
  (hex) => {
    const root = checkerFixture()
    // 放置合法的替代字符路径，避免错误解码后借另一份合规内容通过。
    write(root, 'src/bad-�.ts', '\n'.repeat(800))
    const path = Buffer.concat([
      Buffer.from('src/bad-'),
      Buffer.from(hex, 'hex'),
      Buffer.from('.ts'),
    ])
    const result = runChecker(root, workingPathBytes(root, path))
    expect(result.status).toBe(1)
    expect(JSON.parse(result.stderr.trim())).toMatchObject({
      code: 'SIZE_INPUT_ERROR',
    })
  },
)

it('所选有效索引拒绝无法表示的路径，修复索引后恢复', () => {
  const root = checkerFixture()
  write(root, 'src/regular.ts', '\n')
  git(root, ['add', '--', 'src/regular.ts'])
  const env = { GIT_INDEX_FILE: resolve(root, '.git/selected-index') }
  copyFileSync(resolve(root, '.git/index'), env.GIT_INDEX_FILE)
  indexBytePath(root, Buffer.from('src/bad-\xff.ts', 'latin1'), env)
  expect(runChecker(root).status).toBe(0)
  const rejected = runChecker(root, env)
  expect(rejected.status).toBe(1)
  expect(JSON.parse(rejected.stderr.trim())).toMatchObject({
    code: 'SIZE_INPUT_ERROR',
  })
  copyFileSync(resolve(root, '.git/index'), env.GIT_INDEX_FILE)
  expect(runChecker(root, env).status).toBe(0)
})

it.each(['working', 'index'] as const)(
  '非 UTF-8 的非源码 %s 路径仍在规模检查范围外',
  (tree) => {
    const root = checkerFixture()
    const path = Buffer.from('src/icon-\xff.png', 'latin1')
    const env = tree === 'working' ? workingPathBytes(root, path) : {}
    if (tree === 'index') indexBytePath(root, path)
    expect(runChecker(root, env).status).toBe(0)
  },
)

it('合法 Unicode、替代字符和分隔符路径仍检查两份源码并在修复后通过', () => {
  const root = checkerFixture()
  const path = 'src/中文-é-😀-�\t名称\n.ts'
  write(root, path, '\n'.repeat(800))
  git(root, ['add', '--', path])
  expect(runChecker(root).status).toBe(0)
  write(root, path, '\n'.repeat(801))
  git(root, ['add', '--', path])
  write(root, path, '\n'.repeat(800))
  const result = runChecker(root)
  expect(result.status).toBe(1)
  expect(JSON.parse(result.stderr.trim())).toMatchObject({
    code: 'SIZE_LIMIT_EXCEEDED',
    path,
    tree: 'index',
    lines: 801,
  })
  git(root, ['add', '--', path])
  expect(runChecker(root).status).toBe(0)
})

it('合法 Unicode 路径仍与工作和索引祖父基线精确绑定', () => {
  const path = 'src/中文-é-😀.ts'
  const root = checkerFixture({ [path]: 900 })
  write(root, path, '\n'.repeat(900))
  git(root, ['add', '--', path, 'scripts/file-size-baseline.json'])
  const allowed = runChecker(root)
  expect(allowed.status).toBe(0)
  const records = allowed.stdout
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
  for (const tree of ['worktree', 'index']) {
    expect(records).toContainEqual(
      expect.objectContaining({
        code: 'SIZE_GRANDFATHERED',
        path,
        tree,
        limit: 900,
      }),
    )
  }
  write(root, path, '\n'.repeat(901))
  expect(runChecker(root).status).toBe(1)
})

it.each(['shrink', 'remove'] as const)(
  '暂存超限源码后仅在工作树 %s，仍拒绝索引；暂存修复后通过',
  (repair) => {
    const root = checkerFixture()
    const path = 'src/partial space\nand newline.ts'
    const target = write(root, path, '\n'.repeat(801))
    git(root, ['add', '--', path])
    if (repair === 'shrink') writeFileSync(target, '\n'.repeat(800))
    else rmSync(target)
    const result = runChecker(root)
    expect(result.status).toBe(1)
    // SIZE_LIMIT_EXCEEDED 与 tree 字段契约见 File Size Guard。
    expect(JSON.parse(result.stderr.trim())).toMatchObject({
      code: 'SIZE_LIMIT_EXCEEDED',
      path,
      lines: 801,
      tree: 'index',
    })
    git(root, ['add', '-A', '--', path])
    expect(runChecker(root).status).toBe(0)
  },
)

it('合规索引不掩盖超限工作树，检查不改变已暂存的对象', () => {
  const root = checkerFixture()
  const path = 'src/partial.ts'
  write(root, path, '\n'.repeat(800))
  git(root, ['add', '--', path])
  const index = git(root, ['ls-files', '--stage'])
  write(root, path, '\n'.repeat(801))
  const result = runChecker(root)
  expect(result.status).toBe(1)
  expect(JSON.parse(result.stderr.trim())).toMatchObject({
    code: 'SIZE_LIMIT_EXCEEDED',
    tree: 'worktree',
  })
  expect(git(root, ['ls-files', '--stage'])).toBe(index)
  write(root, path, '\n'.repeat(800))
  expect(runChecker(root).status).toBe(0)
})

it('索引测量沿用测试文件上限与有界祖父条款', () => {
  const root = checkerFixture({ 'src/legacy.ts': 900 })
  git(root, ['add', '--', 'scripts/file-size-baseline.json'])
  for (const lines of [900, 901]) {
    write(root, 'src/legacy.ts', '\n'.repeat(lines))
    git(root, ['add', '--', 'src/legacy.ts'])
    write(root, 'src/legacy.ts', '\n'.repeat(800))
    const result = runChecker(root)
    expect(result.status).toBe(lines === 900 ? 0 : 1)
    const diagnostic = result[lines === 900 ? 'stdout' : 'stderr']
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    expect(diagnostic).toContainEqual(
      expect.objectContaining({
        code: lines === 900 ? 'SIZE_GRANDFATHERED' : 'SIZE_LIMIT_EXCEEDED',
        tree: 'index',
        limit: 900,
      }),
    )
  }
  write(root, 'src/legacy.ts', '\n'.repeat(800))
  git(root, ['add', '--', 'src/legacy.ts'])
  write(root, 'src/partial.test.ts', '\n'.repeat(1801))
  git(root, ['add', '--', 'src/partial.test.ts'])
  write(root, 'src/partial.test.ts', '\n'.repeat(1800))
  const result = runChecker(root)
  expect(result.status).toBe(1)
  expect(JSON.parse(result.stderr.trim())).toMatchObject({
    tree: 'index',
    lines: 1801,
    limit: 1800,
  })
})

it.each(['empty', 'absent', 'lower'] as const)(
  '未暂存的宽松基线不能放行索引源码：原索引基线 %s；暂存政策后恢复',
  (state) => {
    const root = checkerFixture()
    const baseline = 'scripts/file-size-baseline.json'
    if (state !== 'absent') {
      write(
        root,
        baseline,
        JSON.stringify({
          version: 1,
          files: state === 'lower' ? { 'src/legacy.ts': 850 } : {},
        }),
      )
      git(root, ['add', '--', baseline])
    }
    write(root, 'src/legacy.ts', '\n'.repeat(900))
    git(root, ['add', '--', 'src/legacy.ts'])
    write(
      root,
      baseline,
      JSON.stringify({ version: 1, files: { 'src/legacy.ts': 900 } }),
    )
    const result = runChecker(root)
    expect(result.status).toBe(1)
    expect(JSON.parse(result.stderr.trim())).toMatchObject({
      code: 'SIZE_LIMIT_EXCEEDED',
      tree: 'index',
      limit: state === 'lower' ? 850 : 800,
    })
    git(root, ['add', '--', baseline])
    expect(runChecker(root).status).toBe(0)
  },
)

it('基线与源码从同一个有效提交索引读取', () => {
  const root = checkerFixture({ 'src/legacy.ts': 900 })
  const baseline = 'scripts/file-size-baseline.json'
  write(root, 'src/legacy.ts', '\n'.repeat(900))
  git(root, ['add', '--', baseline, 'src/legacy.ts'])
  const env = { GIT_INDEX_FILE: resolve(root, '.git', 'selected-index') }
  copyFileSync(resolve(root, '.git', 'index'), env.GIT_INDEX_FILE)
  write(root, baseline, JSON.stringify({ version: 1, files: {} }))
  git(root, ['add', '--', baseline], env)
  write(
    root,
    baseline,
    JSON.stringify({ version: 1, files: { 'src/legacy.ts': 900 } }),
  )
  expect(runChecker(root).status).toBe(0)
  const result = runChecker(root, env)
  expect(result.status).toBe(1)
  expect(JSON.parse(result.stderr.trim())).toMatchObject({
    tree: 'index',
    limit: 800,
  })
})

it('有效索引的宽松基线不能削弱当前门禁政策', () => {
  const root = checkerFixture({ 'src/legacy.ts': 900 })
  write(root, 'src/legacy.ts', '\n'.repeat(900))
  git(root, ['add', '--', 'scripts/file-size-baseline.json', 'src/legacy.ts'])
  write(root, 'src/legacy.ts', '\n'.repeat(800))
  write(
    root,
    'scripts/file-size-baseline.json',
    JSON.stringify({ version: 1, files: { 'src/legacy.ts': 850 } }),
  )
  const result = runChecker(root)
  expect(result.status).toBe(1)
  expect(JSON.parse(result.stderr.trim())).toMatchObject({
    tree: 'index',
    limit: 850,
  })
})

it.each(['json', 'schema', 'symlink', 'unmerged'] as const)(
  '索引基线 %s 时不接受工作树中已经修复的政策文件',
  (state) => {
    const root = checkerFixture({ 'src/legacy.ts': 900 })
    const path = 'scripts/file-size-baseline.json'
    const target = resolve(root, path)
    const valid = readFileSync(target)
    if (state === 'unmerged') {
      const object = git(root, ['hash-object', '-w', '--', path]).trim()
      execFileSync('git', ['update-index', '--index-info'], {
        cwd: root,
        env: environment(),
        input: `100644 ${object} 1\t${path}\n`,
      })
    } else {
      if (state === 'symlink') {
        rmSync(target)
        symlinkSync('missing.json', target)
      } else {
        writeFileSync(
          target,
          state === 'json' ? '{' : '{"version":2,"files":{}}',
        )
      }
      git(root, ['add', '--', path])
      rmSync(target)
      writeFileSync(target, valid)
    }
    write(root, 'src/legacy.ts', '\n'.repeat(900))
    git(root, ['add', '--', 'src/legacy.ts'])
    const result = runChecker(root)
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('SIZE_INPUT_ERROR')
  },
)

it('批量 blob 的内容分帧不把二进制字节或头部样式文本当成协议行', () => {
  const root = checkerFixture()
  const paths = ['src/framing.ts', 'src/repeated blob.ts']
  const content = Buffer.concat([
    Buffer.from('fake blob 7\n雪\0\r\n' + '\n'.repeat(798)),
    Buffer.from([255, 0]),
  ])
  for (const path of paths) writeFileSync(write(root, path, ''), content)
  git(root, ['add', '--', ...paths])
  expect(runChecker(root).status).toBe(0)
  for (const path of paths) {
    writeFileSync(
      resolve(root, path),
      Buffer.concat([content, Buffer.from('\n')]),
    )
  }
  git(root, ['add', '--', ...paths])
  for (const path of paths) writeFileSync(resolve(root, path), content)
  const result = runChecker(root)
  expect(result.status).toBe(1)
  const diagnostics = result.stderr
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
  expect(diagnostics).toHaveLength(2)
  for (const path of paths) {
    expect(diagnostics).toContainEqual(
      expect.objectContaining({
        code: 'SIZE_LIMIT_EXCEEDED',
        path,
        tree: 'index',
        lines: 801,
      }),
    )
  }
})

it('批量读取不引入比逐文件读取更小的总字节限制', () => {
  const root = checkerFixture()
  for (const name of ['a', 'b']) {
    write(root, `src/${name}.ts`, name.repeat(6 * 1024 * 1024) + '\n')
  }
  git(root, ['add', '--', 'src'])
  const result = runChecker(root)
  expect(result.status, result.stderr).toBe(0)
})

it.each(['missing', 'tree'] as const)(
  '索引引用 %s 对象时阻止不完整的批量检查',
  (kind) => {
    const root = checkerFixture()
    const path = 'src/invalid.ts'
    write(root, path, '\n')
    const object =
      kind === 'tree' ? git(root, ['write-tree']).trim() : '1'.repeat(40)
    git(root, ['update-index', '--add', '--cacheinfo', '100644', object, path])
    const result = runChecker(root)
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('SIZE_INPUT_ERROR')
  },
)

it('遵循 Git 暴露的有效提交索引，默认索引合规不能掩盖所选索引超限', () => {
  const root = checkerFixture()
  const path = 'src/selected.ts'
  write(root, path, '\n'.repeat(800))
  git(root, ['add', '--', path])
  const env = { GIT_INDEX_FILE: resolve(root, '.git', 'selected-index') }
  copyFileSync(resolve(root, '.git', 'index'), env.GIT_INDEX_FILE)
  write(root, path, '\n'.repeat(801))
  git(root, ['add', '--', path], env)
  write(root, path, '\n'.repeat(800))
  expect(runChecker(root).status).toBe(0)
  const result = runChecker(root, env)
  expect(result.status).toBe(1)
  expect(JSON.parse(result.stderr.trim())).toMatchObject({ tree: 'index' })
})

it.each(['symlink', 'unmerged'] as const)(
  '工作树合规时仍拒绝不支持的索引输入：%s',
  (input) => {
    const root = checkerFixture()
    const path = 'src/invalid.ts'
    const target = write(root, path, '\n')
    if (input === 'symlink') {
      rmSync(target)
      symlinkSync('missing.ts', target)
      git(root, ['add', '--', path])
      rmSync(target)
      writeFileSync(target, '\n')
    } else {
      const object = git(root, ['hash-object', '-w', '--', path]).trim()
      execFileSync('git', ['update-index', '--index-info'], {
        cwd: root,
        env: environment(),
        input: `100644 ${object} 1\t${path}\n`,
      })
    }
    const result = runChecker(root)
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('SIZE_INPUT_ERROR')
  },
)

it('不将忽略的构建产物、锁文件、图片及根目录外文件当作维护源码', () => {
  const root = checkerFixture()
  write(root, '.gitignore', 'src-tauri/target/\n')
  for (const path of [
    'src-tauri/target/generated.rs',
    'src-tauri/Cargo.lock',
    'src/icon.png',
    'docs/example.ts',
  ]) {
    write(root, path, '\n'.repeat(2000))
  }
  expect(runChecker(root).status).toBe(0)
})

it.each([
  '{',
  '{}',
  '{"version":2,"files":{}}',
  '{"version":1,"files":{"src/a.ts":800}}',
  '{"version":1,"files":{"src/a.ts":900.5}}',
  '{"version":1,"files":{"src/../a.ts":900}}',
  '{"version":1,"files":{"src/a.png":900}}',
  '{"version":1,"files":[]}',
])('基线无效时拒绝不完整检查：%s', (baseline) => {
  const root = checkerFixture()
  write(root, 'scripts/file-size-baseline.json', baseline)
  const result = runChecker(root)
  expect(result.status).toBe(1)
  expect(result.stderr).toContain('SIZE_INPUT_ERROR')
})

it.each(['baseline', 'git', 'source'] as const)(
  '缺失或不安全输入不静默通过：%s',
  (input) => {
    const root = checkerFixture()
    if (input === 'baseline')
      rmSync(resolve(root, 'scripts/file-size-baseline.json'))
    if (input === 'git') rmSync(resolve(root, '.git'), { recursive: true })
    if (input === 'source') {
      mkdirSync(resolve(root, 'src'))
      symlinkSync('../missing.ts', resolve(root, 'src/link.ts'))
    }
    const result = runChecker(root)
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('SIZE_INPUT_ERROR')
  },
)
