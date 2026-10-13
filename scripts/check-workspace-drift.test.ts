/** 双 workspace 共享内核闭包漂移护栏的行为测试（issue #549 方案 3）。 */
import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const scriptPath = resolve(import.meta.dirname, 'check-workspace-drift.ts')
const temporaryRoots: string[] = []

/** 桩环境：bin/ 放 fake `cargo`，fixtures/ 放两侧夹具树，args.log 记录命令行。 */
type StubSetup = {
  sandbox: string
  bin: string
  fixtures: string
  argsFile: string
  mode: 'aligned' | 'drift' | 'cargo-fails' | 'garbage-trees'
}

function stubCargoEnvironment(mode: StubSetup['mode']): StubSetup {
  const sandbox = mkdtempSync(resolve(tmpdir(), 'plotweave-drift-'))
  temporaryRoots.push(sandbox)
  const bin = resolve(sandbox, 'bin')
  const fixtures = resolve(sandbox, 'fixtures')
  mkdirSync(bin)
  mkdirSync(fixtures)
  return {
    sandbox,
    bin,
    fixtures,
    argsFile: resolve(sandbox, 'args.log'),
    mode,
  }
}

/**
 * 夹具树复刻 `cargo tree --prefix none` 行形状：`name vX.Y.Z [本地路径]`，
 * 允许重复行。aligned 两侧共享包版本一致（含仅一侧出现的包）；drift 侧
 * 刻意让 syn 落后并多出一个 2.x 旧槽位、bitflags 落后一个小版本。
 */
const cratesTree = [
  'plotweave-core v0.1.0 (/repo/crates/plotweave-core)',
  'serde v1.0.229',
  'serde_derive v1.0.229',
  'syn v3.0.5',
  'bitflags v2.13.2',
  'ipnet v2.12.2',
  'cap-std v4.0.3',
  'cap-std v4.0.3',
  'only-in-crates v1.2.3',
  '',
].join('\n')

const srcTauriTreeAligned = [
  'plotweave-core v0.1.0 (/repo/crates/plotweave-core)',
  'serde v1.0.229',
  'serde_derive v1.0.229',
  'syn v3.0.5',
  'bitflags v2.13.2',
  'ipnet v2.12.2',
  'cap-std v4.0.3',
  'only-in-src-tauri v0.9.1',
  '',
].join('\n')

const srcTauriTreeDrift = [
  'plotweave-core v0.1.0 (/repo/crates/plotweave-core)',
  'serde v1.0.229',
  'serde_derive v1.0.229',
  'syn v2.0.119',
  'syn v3.0.3',
  'bitflags v2.13.1',
  'ipnet v2.12.2',
  'cap-std v4.0.3',
  '',
].join('\n')

/** fake `cargo`：按调用 cwd 分发对应夹具树；`--locked` 失同步场景直接失败。 */
function installFakeCargo(setup: StubSetup) {
  const { bin, fixtures, argsFile, mode } = setup
  const cargo = resolve(bin, 'cargo')
  const lines = [
    '#!/bin/sh',
    `printf '%s\\n' "$@" > ${JSON.stringify(argsFile)}`,
    mode === 'cargo-fails'
      ? 'echo "error: the lock file needs to be updated but --locked was passed" >&2\nexit 7'
      : mode === 'garbage-trees'
        ? [
            // cargo tree 退出 0 但输出无任何 `name vX.Y.Z` 行（评审 5506545630：
            // 未来输出格式变更或包装器场景），闭包解析结果为空。
            'case "$PWD" in',
            '  */crates) echo "some future cargo tree output format" ;;',
            `  */src-tauri) cat ${JSON.stringify(resolve(fixtures, 'src-tauri.txt'))} ;;`,
            '  *) echo "unexpected cwd: $PWD" >&2; exit 9 ;;',
            'esac',
          ].join('\n')
        : [
            'case "$PWD" in',
            `  */crates) cat ${JSON.stringify(resolve(fixtures, 'crates.txt'))} ;;`,
            `  */src-tauri) cat ${JSON.stringify(resolve(fixtures, 'src-tauri.txt'))} ;;`,
            '  *) echo "unexpected cwd: $PWD" >&2; exit 9 ;;',
            'esac',
          ].join('\n'),
    '',
  ].join('\n')
  writeFileSync(cargo, lines)
  chmodSync(cargo, 0o755)
  if (mode !== 'cargo-fails') {
    writeFileSync(resolve(fixtures, 'crates.txt'), cratesTree)
    writeFileSync(
      resolve(fixtures, 'src-tauri.txt'),
      mode === 'aligned' ? srcTauriTreeAligned : srcTauriTreeDrift,
    )
  }
  return cargo
}

/** 运行被检脚本：PATH 前置桩 bin，cargo tree 由 fake cargo 应答。 */
function runCheck(setup: StubSetup) {
  installFakeCargo(setup)
  const environment = {
    ...process.env,
    PATH: `${setup.bin}:${process.env.PATH}`,
  }
  const result = spawnSync(process.execPath, [scriptPath], {
    encoding: 'utf8',
    env: environment,
  })
  return { result, argsFile: setup.argsFile }
}

/** 脚本输出为逐行 JSON 诊断（稳定诊断码 + 字段），解析为对象数组。 */
function diagnosticsOf(output: string): Record<string, unknown>[] {
  return output
    .split('\n')
    .filter((line) => line.startsWith('{'))
    .map((line) => JSON.parse(line) as Record<string, unknown>)
}

function byCode(entries: Record<string, unknown>[], code: string) {
  return entries.filter((entry) => entry.code === code)
}

afterEach(() => {
  while (temporaryRoots.length > 0) {
    rmSync(temporaryRoots.pop() as string, { force: true, recursive: true })
  }
})

describe('check-workspace-drift（issue #549）', () => {
  it('共享包版本一致时通过：仅一侧出现的包降级为警告，不改变退出码', () => {
    const { result, argsFile } = runCheck(stubCargoEnvironment('aligned'))
    expect(result.status).toBe(0)
    const stdout = diagnosticsOf(result.stdout)
    const complete = byCode(stdout, 'DRIFT_CHECK_COMPLETE')[0]
    expect(complete?.passed).toBe(true)
    expect(byCode(stdout, 'DRIFT_VERSION_MISMATCH')).toEqual([])
    // 仅一侧出现属双 workspace feature 统一的结构性差异：警告但不失败。
    const sideOnly = byCode(stdout, 'DRIFT_SIDE_ONLY')
    expect(sideOnly.map((entry) => [entry.side, entry.package])).toEqual([
      ['crates', 'only-in-crates'],
      ['src-tauri', 'only-in-src-tauri'],
    ])
    // 命令契约：--locked 保证检查永不改写锁文件。
    const args = readFileSync(argsFile, 'utf8')
    expect(args).toContain('--locked')
    expect(args).toContain('plotweave-core')
  })

  it('共享包版本漂移时失败：逐包列出两侧版本集', () => {
    const { result } = runCheck(stubCargoEnvironment('drift'))
    expect(result.status).toBe(1)
    const stdout = diagnosticsOf(result.stdout)
    const drifts = byCode(stdout, 'DRIFT_VERSION_MISMATCH')
    const byPackage = new Map(
      drifts.map((entry) => [String(entry.package), entry]),
    )
    expect(byPackage.get('syn')?.crates).toEqual(['3.0.5'])
    expect(byPackage.get('syn')?.['src-tauri']).toEqual(['2.0.119', '3.0.3'])
    expect(byPackage.get('bitflags')?.['src-tauri']).toEqual(['2.13.1'])
    expect(byPackage.has('ipnet')).toBe(false)
    expect(byCode(stdout, 'DRIFT_CHECK_COMPLETE')[0]?.passed).toBe(false)
  })

  it('cargo tree 失败（如锁与 manifest 失同步）时透传失败，不留半截结论', () => {
    const { result } = runCheck(stubCargoEnvironment('cargo-fails'))
    expect(result.status).not.toBe(0)
    const stderr = diagnosticsOf(result.stderr)
    const failure = byCode(stderr, 'DRIFT_CARGO_FAILED')[0]
    expect(failure?.workspace).toBe('crates')
    expect(String(failure?.stderr ?? '')).toContain('--locked')
    expect(diagnosticsOf(result.stdout).length).toBe(0)
  })

  it('cargo tree 退出 0 但解析不出根包时失败：空闭包不得静默通过（评审 5506545630）', () => {
    const { result } = runCheck(stubCargoEnvironment('garbage-trees'))
    expect(result.status).not.toBe(0)
    const stderr = diagnosticsOf(result.stderr)
    const invalid = byCode(stderr, 'DRIFT_CLOSURE_INVALID')[0]
    expect(invalid?.workspace).toBe('crates')
    expect(invalid?.root).toBe('plotweave-core')
    // 不留半截结论：不产出比较汇总，也不把另一侧的包降级成警告放行。
    const stdout = diagnosticsOf(result.stdout)
    expect(byCode(stdout, 'DRIFT_CHECK_COMPLETE')).toEqual([])
    expect(byCode(stdout, 'DRIFT_SIDE_ONLY')).toEqual([])
  })
})
