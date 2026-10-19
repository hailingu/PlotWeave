/** Shared Tauri storage fixture: one typed IPC interception point and an owned test clock. */
import { afterEach, beforeEach, expect, vi } from 'vitest'

/** Install a fresh module graph, command log and fake clock for each storage test. */
export function setupProjectStoreHarness(
  defaultList: () => unknown,
  windowFixture: () => unknown,
) {
  const handlers = new Map<string, (args: unknown) => unknown>()
  const calls: Array<{ cmd: string; args: unknown }> = []
  beforeEach(() => {
    vi.resetModules()
    vi.useFakeTimers()
    vi.stubGlobal('window', windowFixture())
    handlers.clear()
    calls.length = 0
    handlers.set('verify_project_assets', () => [])
    // A nonempty default avoids recursively seeding a mock that always reports an empty library.
    handlers.set('list_projects', defaultList)
    vi.doMock('./ipc/invoke', () => ({
      ipcInvoke: async (cmd: string, args?: unknown) => {
        calls.push({ cmd, args })
        const handler = handlers.get(cmd)
        if (!handler) throw new Error(`Unscripted storage command: ${cmd}`)
        return handler(args)
      },
    }))
  })
  afterEach(() => {
    if (vi.isFakeTimers()) vi.clearAllTimers()
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.doUnmock('./ipc/invoke')
  })
  return {
    handlers,
    calls,
    load: async (): Promise<typeof import('./projectStore')> =>
      import('./projectStore'),
    // Drain currently runnable promises and zero-delay work while service gates remain held.
    checkpoint: () => vi.advanceTimersByTimeAsync(0),
    waitForCommand: async (cmd: string, count = 1) => {
      await vi.waitFor(() =>
        expect(calls.filter((call) => call.cmd === cmd)).toHaveLength(count),
      )
    },
    // Production chain quiescence includes rejection recovery and any newly queued replay.
    waitForIdle: async (id: string) => {
      const { waitForSaveChainIdle } = await import('./projectStore/saveChain')
      await waitForSaveChainIdle(id)
    },
  }
}
