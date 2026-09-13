import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  enqueueDelete,
  enqueueProjectWrite,
  enqueueSave,
  onProjectSaved,
  onProjectWriteReplayFailure,
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
    const off = onProjectWriteReplayFailure((failedId, err) => failures.push({ id: failedId, err }))
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
