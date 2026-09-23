import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  enqueueDelete,
  enqueueProjectWrite,
  enqueueSave,
  flushPendingProjectSaves,
  hasPendingProjectSaves,
  onProjectSaved,
  onProjectWriteReplayFailure,
  onRetryPersisted,
} from './saveChain'
import type { ProjectContent } from '../model/content'

const invoke = vi.fn()

vi.mock('@tauri-apps/api/core', () => ({ invoke }))

const DOC: ProjectContent = {
  name: '项目',
  nodes: [],
  edges: [],
  settings: { characters: [], locations: [] },
}

/** 统计 save_project 写入载荷中的文档名（ProjectDocument.project.name）。 */
function savedNames(): string[] {
  return invoke.mock.calls
    .filter(([command]) => command === 'save_project')
    .map(([, payload]) => {
      const doc = (payload as { doc: { project: { name: string } } }).doc
      return doc.project.name
    })
}

describe('保存落定通知（issue #101：返回首页后摘要跟随最终保存结果）', () => {
  afterEach(() => vi.clearAllMocks())

  it('保存成功：通知订阅者（含卸载冲刷/链上重试等一切链上成功保存）', async () => {
    const id = 'saved-notify-success-test'
    const seen: string[] = []
    const off = onProjectSaved((savedId) => seen.push(savedId))
    try {
      invoke.mockImplementation(async () => undefined)
      await enqueueSave(id, DOC)
      expect(seen).toEqual([id])
    } finally {
      off()
    }
  })

  it('保存失败：不通知（磁盘仍是旧内容，首页不得虚报新摘要）', async () => {
    const id = 'saved-notify-failure-test'
    const seen: string[] = []
    const off = onProjectSaved((savedId) => seen.push(savedId))
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      invoke.mockImplementation(async (command: string) => {
        if (command === 'save_project') throw new Error('磁盘已满')
      })
      await expect(enqueueSave(id, DOC)).rejects.toThrow('磁盘已满')
      expect(seen).toEqual([])
    } finally {
      // 清除本用例遗留的全局重试登记（后续用例的探针/冲刷断言依赖静止基线）
      invoke.mockImplementation(async () => undefined)
      await flushPendingProjectSaves()
      off()
      error.mockRestore()
    }
  })

  it('失败登记的后台重试成功：通知订阅者（编辑器已卸载时首页据此恢复最新摘要）', async () => {
    const id = 'saved-notify-retry-test'
    const seen: string[] = []
    let off: (() => void) | undefined
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    let failing = true
    invoke.mockImplementation(async (command: string) => {
      if (command === 'save_project' && failing) throw new Error('磁盘已满')
    })
    vi.useFakeTimers()
    try {
      off = onProjectSaved((savedId) => seen.push(savedId))
      await expect(enqueueSave(id, DOC)).rejects.toThrow('磁盘已满')
      expect(seen).toEqual([])
      failing = false
      await vi.advanceTimersByTimeAsync(5000)
      expect(seen).toEqual([id])
    } finally {
      off?.()
      error.mockRestore()
      vi.useRealTimers()
    }
  })
})

describe('项目附属数据保存链', () => {
  afterEach(() => vi.clearAllMocks())

  it('删除会等待已排队写入并吸收删除开始后的写入', async () => {
    const id = 'ai-session-delete-test'
    const events: string[] = []
    let releaseWrite: (() => void) | undefined
    invoke.mockImplementation(async (command: string) => {
      if (command === 'delete_project') events.push('delete')
    })

    const queued = enqueueProjectWrite(
      id,
      () =>
        new Promise<void>((resolve) => {
          events.push('write-start')
          releaseWrite = () => {
            events.push('write-end')
            resolve()
          }
        }),
    )
    await vi.waitFor(() => expect(releaseWrite).toBeTypeOf('function'))
    const deleting = enqueueDelete(id)
    await enqueueProjectWrite(id, async () => {
      events.push('late-write')
    })
    expect(events).toEqual(['write-start'])

    releaseWrite?.()
    await queued
    await deleting

    expect(events).toEqual(['write-start', 'write-end', 'delete'])
  })
})

describe('项目删除与保存协调', () => {
  afterEach(() => vi.clearAllMocks())

  it('删除成功：不回吐画布保存（已删项目不得复活）', async () => {
    const id = 'delete-cleanup-error-test'
    const commands: string[] = []
    invoke.mockImplementation(async (command: string) => {
      commands.push(command)
      return undefined
    })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const deleting = enqueueDelete(id)
    await enqueueSave(id, DOC) // 墓碑期吸收的画布保存
    await deleting
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(commands).not.toContain('save_project')
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it('删除失败（项目仍在）：墓碑期吸收的画布保存回吐重排', async () => {
    const id = 'delete-failure-replay-test'
    const commands: string[] = []
    invoke.mockImplementation(async (command: string) => {
      commands.push(command)
      if (command === 'delete_project') throw new Error('资产目录只读')
      return undefined
    })

    const deleting = enqueueDelete(id).catch(() => undefined)
    await enqueueSave(id, DOC)
    await deleting

    await vi.waitFor(() => expect(commands).toContain('save_project'))
  })

  // 下方两用例与墓碑期「吸收」分支不同：走 enqueueDelete 链落定时读取
  // pendingRetryDocs 的留存登记（retained 分支，PR #292 评审 5288638812
  // 迁移自门面层删除的用例）——事件顺序是删除开始前/排队期间已存在失败
  // 登记，而非墓碑期间新吸收的保存。

  it('删除失败（项目仍在）：墓碑前已登记重试的文档回吐重存（留存登记分支）', async () => {
    const id = 'delete-failure-retained-retry-test'
    let failedOnce = false
    invoke.mockImplementation(async (command: string) => {
      if (command === 'delete_project') throw new Error('资产目录只读')
      if (command === 'save_project' && !failedOnce) {
        failedOnce = true
        throw new Error('磁盘已满')
      }
      return undefined
    })
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})

    try {
      // 删除开始前：一次失败保存已把最新文档登记进重试
      await expect(enqueueSave(id, DOC)).rejects.toThrow('磁盘已满')
      const deleting = enqueueDelete(id).catch(() => undefined)
      await deleting

      // 回吐按登记身份重存——不重存则删除失败后最新编辑既没落盘也无重试
      await vi.waitFor(() => expect(savedNames()).toEqual(['项目', '项目']))
    } finally {
      error.mockRestore()
    }
  })

  it('删除失败（项目仍在）：墓碑排队期间在途保存失败的登记回吐重存（留存登记分支）', async () => {
    const id = 'delete-failure-retained-inflight-test'
    let rejectFirstSave: ((err: Error) => void) | null = null
    invoke.mockImplementation((command: string) => {
      if (command === 'delete_project') {
        return Promise.reject(new Error('资产目录只读'))
      }
      if (rejectFirstSave === null) {
        // 首笔保存在删除排队期间落定失败：失败即登记，随后被删除链读取留存
        return new Promise<void>((_resolve, reject) => {
          rejectFirstSave = reject
        })
      }
      return Promise.resolve()
    })
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})

    try {
      const saving = enqueueSave(id, DOC).catch(() => undefined)
      await vi.waitFor(() => expect(rejectFirstSave).not.toBeNull())
      const deleting = enqueueDelete(id).catch(() => undefined)
      ;(rejectFirstSave as unknown as (err: Error) => void)(
        new Error('磁盘已满'),
      )
      await saving
      await deleting

      // 首笔失败一次、登记被回吐重存一次：不重存则该编辑永远无人重试
      await vi.waitFor(() => expect(savedNames()).toEqual(['项目', '项目']))
    } finally {
      error.mockRestore()
    }
  })

  it('删除失败（项目仍在）：墓碑期吸收的附属写入回吐重排', async () => {
    const id = 'delete-failure-auxiliary-replay-test'
    const commands: string[] = []
    invoke.mockImplementation(async (command: string) => {
      commands.push(command)
      if (command === 'delete_project') throw new Error('资产目录只读')
      return undefined
    })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const deleting = enqueueDelete(id).catch(() => undefined)
    await enqueueProjectWrite(id, async () => {
      commands.push('aux-write')
    })
    await deleting

    await vi.waitFor(() => expect(commands).toContain('aux-write'))
    warn.mockRestore()
  })

  it('删除成功：墓碑期吸收的附属写入不回吐（已删项目不得复活）', async () => {
    const id = 'delete-success-auxiliary-drop-test'
    const commands: string[] = []
    invoke.mockImplementation(async (command: string) => {
      commands.push(command)
      return undefined
    })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const deleting = enqueueDelete(id)
    await enqueueProjectWrite(id, async () => {
      commands.push('aux-write')
    })
    await deleting
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(commands).not.toContain('aux-write')
    warn.mockRestore()
  })

  it('删除失败后回吐重排失败：通知回吐失败订阅者', async () => {
    const id = 'delete-failure-replay-write-failure-test'
    const failures: Array<{ id: string; err: unknown }> = []
    const off = onProjectWriteReplayFailure((failedId, err) =>
      failures.push({ id: failedId, err }),
    )
    invoke.mockImplementation(async (command: string) => {
      if (command === 'delete_project') throw new Error('资产目录只读')
      return undefined
    })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})

    try {
      const deleting = enqueueDelete(id).catch(() => undefined)
      await enqueueProjectWrite(id, async () => {
        throw new Error('会话写入失败')
      })
      await deleting

      await vi.waitFor(() => expect(failures).toHaveLength(1))
      expect(failures[0]?.id).toBe(id)
      expect(String(failures[0]?.err)).toContain('会话写入失败')
    } finally {
      off()
      warn.mockRestore()
      error.mockRestore()
    }
  })
})

describe('退出冲刷：就绪探针与立即重存（issue #119）', () => {
  afterEach(() => vi.clearAllMocks())

  it('hasPendingProjectSaves：在途保存与待重试登记为真，全部静止后为假', async () => {
    const id = 'exit-pending-probe-test'
    expect(hasPendingProjectSaves()).toBe(false)
    const release: { current: (() => void) | null } = { current: null }
    invoke.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          release.current = resolve
        }),
    )
    const saving = enqueueSave(id, DOC)
    expect(hasPendingProjectSaves()).toBe(true)
    // 链上动作经微任务才到达 invoke；等写入挂起后再放行
    await vi.waitFor(() => expect(release.current).not.toBeNull())
    release.current?.()
    await saving
    await vi.waitFor(() => expect(hasPendingProjectSaves()).toBe(false))
  })

  it('flushPendingProjectSaves：登记文档立即重存，不等 5s 后台节律', async () => {
    const id = 'exit-flush-retry-test'
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      invoke.mockImplementation(async () => {
        throw new Error('磁盘已满')
      })
      await expect(enqueueSave(id, { ...DOC, name: '登记稿' })).rejects.toThrow(
        '磁盘已满',
      )
      invoke.mockImplementation(async () => undefined)
      // 未推近任何计时器：冲刷必须自己发起重存
      const failed = await flushPendingProjectSaves()
      expect(failed).toEqual([])
      expect(hasPendingProjectSaves()).toBe(false)
      expect(savedNames()).toEqual(['登记稿', '登记稿'])
    } finally {
      error.mockRestore()
    }
  })

  it('登记文档经链上重存成功时通知订阅者（携带同一文档对象）；首次保存成功不通知', async () => {
    const id = 'retry-notify-test'
    const seen: ProjectContent[] = []
    const off = onRetryPersisted((doc) => seen.push(doc))
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      invoke.mockImplementation(async () => {
        throw new Error('磁盘已满')
      })
      await expect(enqueueSave(id, DOC)).rejects.toThrow('磁盘已满')
      expect(seen).toEqual([])
      invoke.mockImplementation(async () => undefined)
      expect(await flushPendingProjectSaves()).toEqual([])
      // 重存成功：通知携带与登记相同的文档对象（画布闸据此清脏）
      expect(seen).toEqual([DOC])
      // 不经登记的首次保存成功不触发通知
      await enqueueSave(`${id}-fresh`, DOC)
      expect(seen).toEqual([DOC])
    } finally {
      off()
      error.mockRestore()
    }
  })
})

describe('退出冲刷：重试落盘后的冗余登记抑制（PR #174 评审）', () => {
  afterEach(() => vi.clearAllMocks())

  it('重试落盘后的同对象冗余保存失败：不登记重试、不阻断退出（PR #174 评审）', async () => {
    const id = 'retry-persisted-dup-test'
    const doc = { ...DOC, name: '同对象稿' }
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.useFakeTimers()
    try {
      invoke.mockImplementation(async () => {
        throw new Error('磁盘已满')
      })
      await expect(enqueueSave(id, doc)).rejects.toThrow('磁盘已满')
      // 冲刷发起的重试成功：内容落盘、登记清除
      invoke.mockImplementation(async () => undefined)
      expect(await flushPendingProjectSaves()).toEqual([])
      // 同一文档对象的冗余重复保存再失败：磁盘已持有该内容，不得再登记
      invoke.mockImplementation(async () => {
        throw new Error('间歇故障')
      })
      await expect(enqueueSave(id, doc)).rejects.toThrow('间歇故障')
      expect(hasPendingProjectSaves()).toBe(false)
      expect(await flushPendingProjectSaves()).toEqual([])
      // 后台 5s 节律也无登记可重试（三次 invoke：首次失败 + 重试成功 + 冗余失败）
      await vi.advanceTimersByTimeAsync(5000)
      expect(savedNames()).toHaveLength(3)
      // 不同内容（新对象）的失败照常登记重试
      await expect(enqueueSave(id, { ...DOC, name: '新稿' })).rejects.toThrow(
        '间歇故障',
      )
      expect(hasPendingProjectSaves()).toBe(true)
    } finally {
      invoke.mockImplementation(async () => undefined)
      await flushPendingProjectSaves()
      error.mockRestore()
      vi.useRealTimers()
    }
  })
})

describe('退出冲刷：重试仍失败的阻断与后台节律（issue #119）', () => {
  afterEach(() => vi.clearAllMocks())

  it('flushPendingProjectSaves：冲刷重试仍失败时返回项目 id，登记与后台节律保留', async () => {
    const id = 'exit-flush-fail-test'
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.useFakeTimers()
    try {
      invoke.mockImplementation(async () => {
        throw new Error('磁盘仍满')
      })
      await expect(enqueueSave(id, DOC)).rejects.toThrow('磁盘仍满')
      const failed = await flushPendingProjectSaves()
      expect(failed).toEqual([id])
      expect(hasPendingProjectSaves()).toBe(true)
      // 失败尝试 + 冲刷重试各一次（每登记至多尝试一次，不紧循环）
      expect(savedNames()).toEqual([DOC.name, DOC.name])
      // 后台 5s 节律仍接管：到点再次重试
      await vi.advanceTimersByTimeAsync(5000)
      expect(savedNames()).toHaveLength(3)
    } finally {
      // 清除本用例遗留的重试登记（后续用例的冲刷断言依赖静止基线）
      invoke.mockImplementation(async () => undefined)
      await flushPendingProjectSaves()
      error.mockRestore()
      vi.useRealTimers()
    }
  })
})

describe('退出冲刷：代次守卫（陈旧稿不得覆盖新内容，issue #119）', () => {
  afterEach(() => vi.clearAllMocks())

  it('flushPendingProjectSaves：代次前进后不重放陈旧登记（陈旧稿不得覆盖新内容）', async () => {
    const id = 'exit-flush-stale-test'
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      invoke.mockImplementation(async () => {
        throw new Error('磁盘已满')
      })
      await expect(enqueueSave(id, { ...DOC, name: '陈旧稿' })).rejects.toThrow(
        '磁盘已满',
      )
      // 更新保存排队（代次前进），写入挂起在 invoke 上
      const release: { current: (() => void) | null } = { current: null }
      invoke.mockImplementation(
        () =>
          new Promise<void>((resolve) => {
            release.current = resolve
          }),
      )
      const savingNew = enqueueSave(id, { ...DOC, name: '新稿' })
      const flushing = flushPendingProjectSaves()
      // 链上前一保存（陈旧稿的失败链接）落定后新稿写入才到达 invoke
      await vi.waitFor(() => expect(release.current).not.toBeNull())
      release.current?.()
      await savingNew
      expect(await flushing).toEqual([])
      // 陈旧稿只有最初那次失败尝试：冲刷不得把它重放到新稿之后
      expect(savedNames()).toEqual(['陈旧稿', '新稿'])
    } finally {
      error.mockRestore()
    }
  })

  it('flushPendingProjectSaves：冲刷等待期间登记被新代次取代并失败时，新登记仍重存一次（PR #174 评审：陈旧空操作不得标记已尝试）', async () => {
    const id = 'exit-flush-regen-test'
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.useFakeTimers()
    try {
      // 第一代保存失败登记
      invoke.mockImplementation(async () => {
        throw new Error('磁盘已满')
      })
      await expect(enqueueSave(id, { ...DOC, name: '一代稿' })).rejects.toThrow(
        '磁盘已满',
      )
      // 更新保存排队（代次前进）且写入挂起
      const pendingWrites: Array<{
        resolve: () => void
        reject: (e: Error) => void
      }> = []
      invoke.mockImplementation(
        () =>
          new Promise<void>((resolve, reject) => {
            pendingWrites.push({ resolve, reject })
          }),
      )
      const savingNew = enqueueSave(id, { ...DOC, name: '二代稿' })
      const flushing = flushPendingProjectSaves()
      // 更新保存在冲刷等待期间失败：登记被替换为二代稿
      await vi.waitFor(() => expect(pendingWrites).toHaveLength(1))
      pendingWrites[0]!.reject(new Error('磁盘仍满'))
      await expect(savingNew).rejects.toThrow('磁盘仍满')
      // 新登记必须被冲刷实际重存一次（而非因 id 已标记为已尝试直接放行失败）
      await vi.waitFor(() => expect(pendingWrites).toHaveLength(2))
      pendingWrites[1]!.resolve()
      expect(await flushing).toEqual([])
      expect(savedNames()).toEqual(['一代稿', '二代稿', '二代稿'])
      // 烧掉登记成功后仍挂着的旧代次重试定时器（代次不符自灭）
      await vi.advanceTimersByTimeAsync(5000)
    } finally {
      error.mockRestore()
      vi.useRealTimers()
    }
  })
})

describe('退出冲刷：他入口重试与冲刷并发（同文档对象新代次，PR #174 评审）', () => {
  afterEach(() => vi.clearAllMocks())

  it('他入口同对象保存与冲刷重存并发：重存先成功，他入口失败免登记（磁盘已持有该内容）', async () => {
    const id = 'exit-flush-samedoc-test'
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.useFakeTimers()
    try {
      const sameDoc = { ...DOC, name: '同对象稿' }
      // 首次保存失败登记（代次 1）
      invoke.mockImplementation(async () => {
        throw new Error('磁盘已满')
      })
      await expect(enqueueSave(id, sameDoc)).rejects.toThrow('磁盘已满')
      // 冲刷发起的重存在途挂起；期间另一入口（如编辑器防抖重试）以同一
      // 文档对象再次排队（串行链上随后者落定才到达 invoke）
      const pendingWrites: Array<{
        resolve: () => void
        reject: (e: Error) => void
      }> = []
      invoke.mockImplementation(
        () =>
          new Promise<void>((resolve, reject) => {
            pendingWrites.push({ resolve, reject })
          }),
      )
      const flushing = flushPendingProjectSaves()
      const racing = enqueueSave(id, sameDoc)
      await vi.waitFor(() => expect(pendingWrites).toHaveLength(1))
      // 冲刷自身重存成功（登记清除、落盘记忆），随后的他入口保存失败：
      // 同对象内容已在磁盘，免登记重试（PR #174 评审：不假性阻断退出）
      pendingWrites[0]!.resolve()
      await vi.waitFor(() => expect(pendingWrites).toHaveLength(2))
      pendingWrites[1]!.reject(new Error('磁盘仍满'))
      await expect(racing).rejects.toThrow('磁盘仍满')
      expect(await flushing).toEqual([])
      // 无第三次写入、无登记：5s 节律与退出冲刷均无物可重试
      expect(pendingWrites).toHaveLength(2)
      await vi.advanceTimersByTimeAsync(5000)
      expect(pendingWrites).toHaveLength(2)
    } finally {
      error.mockRestore()
      vi.useRealTimers()
    }
  })
})
