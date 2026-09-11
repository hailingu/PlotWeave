import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  enqueueDelete,
  enqueueProjectWrite,
  enqueueSave,
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
