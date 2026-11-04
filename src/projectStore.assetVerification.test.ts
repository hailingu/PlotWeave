/** Host verification failures must stop normalization before metadata can be discarded (#915). */
import { expect, it } from 'vitest'
import { setupProjectStoreHarness } from './projectStoreTestHarness'

const { handlers, calls, load } = setupProjectStoreHarness(
  () => [
    {
      id: 'p1',
      name: '保留媒体',
      updated_at: stamp,
      scene_count: 0,
      ending_count: 0,
    },
  ],
  () => ({ __TAURI_INTERNALS__: {} }),
)
const stamp = '2026-01-01T00:00:00.000Z'
const asset = {
  id: 'a1',
  relPath: 'assets/a1.png',
  mime: 'image/png',
  source: 'upload',
  createdAt: stamp,
}

/** A complete persisted envelope keeps assertions focused on verification, independent of shape repair. */
function file() {
  return {
    schemaVersion: 1,
    project: { id: 'p1', name: '保留媒体', createdAt: stamp, updatedAt: stamp },
    graph: { nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } },
    settings: { characters: {}, locations: {}, props: {}, documents: {} },
    episodeTitles: {},
    assets: { byId: { a1: { ...asset } } },
  }
}

it('rejects transient verification before normalization and saves complete metadata after retry', async () => {
  const disk = file()
  handlers.set('load_project', () => structuredClone(disk))
  handlers.set('verify_project_assets', () => {
    throw new Error('transient EIO')
  })
  const { projectStore } = await load()
  await expect(projectStore.load('p1')).rejects.toThrow('transient EIO')
  expect(calls.filter(({ cmd }) => cmd === 'save_project')).toHaveLength(0)
  expect(disk.assets.byId.a1).toEqual(asset)
  handlers.set('verify_project_assets', () => [])
  const content = await projectStore.load('p1')
  expect(content.assets?.byId.a1).toEqual(asset)
  handlers.set('save_project', (args) => {
    const saved = args as { doc: ReturnType<typeof file> }
    expect(saved.doc.assets.byId.a1).toEqual(asset)
    disk.project.name = saved.doc.project.name
  })
  await projectStore.save('p1', { ...content, name: '恢复编辑' })
  expect((await projectStore.load('p1')).assets?.byId.a1).toEqual(asset)
  expect(disk.project.name).toBe('恢复编辑')
})

it('retains a failed-save retry document when revalidation fails', async () => {
  handlers.set('load_project', file)
  const { projectStore } = await load()
  const content = await projectStore.load('p1')
  handlers.set('save_project', () => {
    throw new Error('save unavailable')
  })
  await expect(projectStore.save('p1', content)).rejects.toThrow(
    'save unavailable',
  )
  const { pendingRetryDocOf } = await import('./projectStore/saveChain')
  const pending = pendingRetryDocOf('p1')
  handlers.set('verify_project_assets', () => {
    throw new Error('transient EMFILE')
  })
  await expect(projectStore.load('p1')).rejects.toThrow('transient EMFILE')
  expect(pendingRetryDocOf('p1')).toBe(pending)
  expect(pending?.assets?.byId.a1).toEqual(asset)
  handlers.set('verify_project_assets', () => [])
  expect((await projectStore.load('p1')).assets?.byId.a1).toEqual(asset)
})
