import { describe, expect, it } from 'vitest'
import { sessionDoc } from './sessionDoc'
import { EMPTY_SETTINGS } from './settings'
import type { ProjectContent } from '../model/content'
import type { CanvasNode } from './nodes/types'

const node = { id: 's1', type: 'scene', position: { x: 0, y: 0 }, data: {} } as unknown as CanvasNode

/** 透传保真（P1 评审）：description/assets 等编辑器不编辑的字段，
 * 每次构建会话文档都必须原样携带，否则保存即丢。 */
describe('sessionDoc（编辑器会话文档构建）', () => {
  it('透传 project 元信息与资产桶，画布字段取自编辑器状态', () => {
    const project = {
      id: 'p-1',
      name: '午夜出租车',
      description: '故事板',
      createdAt: '2026-08-01T00:00:00.000Z',
      nodes: [],
      edges: [],
      settings: EMPTY_SETTINGS,
      assets: { byId: { 'a-1': { id: 'a-1', relPath: 'assets/x.png', mime: 'image/png', source: 'upload' as const, createdAt: '' } } },
    }
    const doc = sessionDoc(project, {
      nodes: [node],
      edges: [],
      settings: EMPTY_SETTINGS,
      episodeTitles: { 1: '初遇' },
      viewport: { x: 1, y: 2, zoom: 1 },
    })
    expect(doc.name).toBe('午夜出租车')
    expect(doc.createdAt).toBe('2026-08-01T00:00:00.000Z')
    expect(doc.description).toBe('故事板')
    expect(doc.assets?.byId['a-1']).toBeDefined()
    expect(doc.nodes).toEqual([node])
    expect(doc.episodeTitles).toEqual({ 1: '初遇' })
    expect(doc.viewport).toEqual({ x: 1, y: 2, zoom: 1 })
  })

  it('与 ProjectContent 形状兼容（可直传 useDebouncedSave）', () => {
    const project = { id: 'p-1', name: '', nodes: [], edges: [], settings: EMPTY_SETTINGS }
    const doc: ProjectContent = sessionDoc(project, {
      nodes: [],
      edges: [],
      settings: EMPTY_SETTINGS,
      episodeTitles: undefined,
      viewport: undefined,
    })
    expect(doc.episodeTitles).toBeUndefined()
    expect(doc.viewport).toBeUndefined()
  })
})
