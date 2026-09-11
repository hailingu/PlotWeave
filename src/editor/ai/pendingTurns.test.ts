/**
 * 在途回合注册表语义（issue #63）：按项目身份独占转交——取走即移除、
 * 仅同盒子可撤销、认领方归还不得覆盖新回合。模块级 Map 跨用例共享，
 * 每用例使用独立项目 id。
 */
import { describe, expect, it } from 'vitest'
import {
  registerTurn,
  returnTurn,
  takeTurn,
  unregisterTurn,
  type TurnBox,
} from './pendingTurns'

const settled = Promise.resolve({ entries: [], error: null })

function box(promise: Promise<unknown> = settled): TurnBox {
  return { promise: promise as TurnBox['promise'] }
}

describe('pendingTurns 注册表', () => {
  it('登记后取走独占：再次取走为空', () => {
    const first = box()
    registerTurn('p-take', first)
    expect(takeTurn('p-take')).toBe(first)
    expect(takeTurn('p-take')).toBeNull()
  })

  it('未登记的项目取走为空', () => {
    expect(takeTurn('p-absent')).toBeNull()
  })

  it('撤销只移除自己的盒子：不得清掉后来登记的新回合', () => {
    const old = box()
    const next = box()
    registerTurn('p-unreg', old)
    unregisterTurn('p-unreg', next)
    expect(takeTurn('p-unreg')).toBe(old)
    unregisterTurn('p-unreg', old)
    expect(takeTurn('p-unreg')).toBeNull()
  })

  it('认领方归还不得覆盖已占用槽位', () => {
    const claimed = box()
    const newer = box()
    registerTurn('p-return', newer)
    returnTurn('p-return', claimed)
    expect(takeTurn('p-return')).toBe(newer)
  })

  it('槽位空闲时归还成功，等待下次认领', () => {
    const claimed = box()
    returnTurn('p-return-empty', claimed)
    expect(takeTurn('p-return-empty')).toBe(claimed)
  })
})
