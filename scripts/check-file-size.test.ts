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
