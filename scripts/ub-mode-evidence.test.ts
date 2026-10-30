/** #941：对象、时效、记录结构与日志字节的行为策略。 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import {
  ubArtifact,
  validateUbReceipt,
  type UbReceipt,
} from './ub-mode-evidence'

const roots: string[] = []
afterEach(() =>
  roots
    .splice(0)
    .forEach((root) => rmSync(root, { recursive: true, force: true })),
)

/** 每个产物独占目录，测试实际文件摘要，不共享可变字节。 */
function record() {
  const root = mkdtempSync(resolve(tmpdir(), 'plotweave-ub-record-'))
  roots.push(root)
  const artifact = (name: string) => {
    const path = resolve(root, name)
    writeFileSync(path, `actual fixture output: ${name}`)
    return ubArtifact(path)
  }
  const receipt: UbReceipt = {
    version: 1,
    head: 'head',
    tree: 'tree',
    base: 'base',
    finishedAt: 100_000_000,
    skill: artifact('skill'),
    review: artifact('review'),
    checks: ['coverage', 'complexity', 'duplication', 'mutation'].map(
      (name) => ({
        name,
        mode: 'tool',
        command: [name],
        artifact: artifact(name),
      }),
    ),
  }
  const verify = (value: unknown = receipt, now = receipt.finishedAt) =>
    validateUbReceipt(value, 'head', 'tree', receipt.skill, now)
  return { receipt, verify }
}

it('完整真实产物绑定且未过期时通过', () => {
  const f = record()
  expect(f.verify()).toEqual(f.receipt)
  expect(f.verify(f.receipt, f.receipt.finishedAt + 86_399_999)).toEqual(
    f.receipt,
  )
})

it.each([86_400_000, 86_400_001, -1])('过期或未来记录阻断：%s', (offset) => {
  const f = record()
  expect(() => f.verify(f.receipt, f.receipt.finishedAt + offset)).toThrow(
    'UB_MODE_EXPIRED',
  )
})

it.each([{ head: 'other' }, { tree: 'other' }, { version: 2 }])(
  '提交内容或协议改变阻断：%j',
  (change) => {
    const f = record()
    expect(() => f.verify({ ...f.receipt, ...change })).toThrow(
      'UB_MODE_OBJECT_MISMATCH',
    )
  },
)

it('技能变更、检查缺失或人工覆盖率不能通过', () => {
  const f = record()
  expect(() =>
    f.verify({ ...f.receipt, skill: { ...f.receipt.skill, sha256: 'other' } }),
  ).toThrow('UB_MODE_SKILL_CHANGED')
  expect(() => f.verify({ ...f.receipt, checks: [] })).toThrow(
    'UB_MODE_INCOMPLETE',
  )
  f.receipt.checks[0]!.mode = 'manual'
  expect(() => f.verify()).toThrow('UB_MODE_INCOMPLETE')
})

it('已有日志变更不能重用记录', () => {
  const f = record()
  writeFileSync(f.receipt.checks[2]!.artifact.path, 'rewritten')
  expect(() => f.verify()).toThrow('UB_MODE_ARTIFACT_CHANGED')
})

it.each([
  null,
  false,
  {},
  { version: 1, head: 'head', tree: 'tree', finishedAt: 'now' },
])('格式不完整失败：%j', (value) => {
  expect(() => record().verify(value)).toThrow('UB_MODE_')
})

it('非法检查模式、缺少命令与原始审查文件阻断', () => {
  const f = record()
  expect(() =>
    f.verify({
      ...f.receipt,
      checks: f.receipt.checks.map((c) => ({ ...c, mode: 'skip' })),
    }),
  ).toThrow('UB_MODE_INVALID')
  expect(() =>
    f.verify({
      ...f.receipt,
      checks: f.receipt.checks.map((c) => ({ ...c, command: [] })),
    }),
  ).toThrow('UB_MODE_INVALID')
  expect(() => f.verify({ ...f.receipt, review: undefined })).toThrow(
    'UB_MODE_INVALID',
  )
})

it.each([NaN, Infinity, -Infinity])(
  '非有限时间戳按格式错误阻断：%s',
  (finishedAt) => {
    const f = record()
    expect(() => f.verify({ ...f.receipt, finishedAt })).toThrow(
      'UB_MODE_INVALID',
    )
  },
)

it('技能摘要缺失给出稳定的技能变更诊断', () => {
  const f = record()
  expect(() => f.verify({ ...f.receipt, skill: undefined })).toThrow(
    'UB_MODE_SKILL_CHANGED',
  )
})
