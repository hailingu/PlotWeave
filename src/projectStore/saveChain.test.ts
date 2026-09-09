import { afterEach, describe, expect, it, vi } from 'vitest'
import { enqueueDelete, enqueueProjectWrite } from './saveChain'

const invoke = vi.fn()

vi.mock('@tauri-apps/api/core', () => ({ invoke }))

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
