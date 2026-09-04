/**
 * 图片节点（生成侧媒体节点，docs/data-model.md §4.1/§13）的序列化与
 * 归一化契约：四分区往返（无 label/episodeNo 镜像）、outputs 槽位的容器
 * 修复与 primary 引用校验、必填标量隔离、剧情流端点排除（孤儿边）。
 */
import { describe, expect, it } from 'vitest'
import { parseProject, serializeProject } from './convert'
import { NOW, mkContent } from './convertFixtures'
import type { CanvasNode } from '../editor/nodes/types'

/** 图片节点样例（文生图首版）：prompt/model/size + outputs.primary 产物引用。 */
function mkImageNode(over: Record<string, unknown> = {}): CanvasNode {
  return {
    id: 'img1',
    type: 'image',
    position: { x: 40, y: 80 },
    data: {
      prompt: '雨夜霓虹街道，中景',
      model: 'openai:gpt-image-1',
      size: '1024x1536',
      outputs: { primary: { assetId: 'pa-1' } },
      ...over,
    },
  } as unknown as CanvasNode
}

/** 含图片节点 + 产物资产的会话文档（产物资产已入 assets.byId）。 */
function contentWithImage(): ReturnType<typeof mkContent> {
  const content = mkContent()
  content.assets = {
    byId: {
      'pa-1': {
        id: 'pa-1',
        relPath: 'assets/pa-1.png',
        mime: 'image/png',
        source: 'generated',
        createdAt: '2026-08-28T12:00:00.000Z',
      },
    },
  }
  content.nodes = [...content.nodes, mkImageNode()]
  return content
}

/** 落盘文档里取图片节点（任意变异后的读取入口）。 */
const imageDocNode = (doc: { graph: { nodes: unknown[] } }) =>
  doc.graph.nodes.find((n) => (n as { id?: string }).id === 'img1') as Record<string, unknown>

describe('图片节点：序列化四分区往返（§4.1，无 label/episodeNo 镜像）', () => {
  it('spec 承载 prompt/model/size/outputs；meta 不落 label；parse 后运行态字段齐备', () => {
    const doc = serializeProject(contentWithImage(), 'p-1', NOW)
    const raw = imageDocNode(doc) as {
      data: { spec: Record<string, unknown>; meta: Record<string, unknown> }
    }
    expect(raw.data.spec).toEqual({
      prompt: '雨夜霓虹街道，中景',
      model: 'openai:gpt-image-1',
      size: '1024x1536',
      outputs: { primary: { assetId: 'pa-1' } },
    })
    expect('label' in raw.data.meta).toBe(false)
    expect('episodeNo' in raw.data.meta).toBe(false)
    const round = parseProject(structuredClone(doc))
    const node = round.content.nodes.find((n) => n.id === 'img1')!
    expect(node.type).toBe('image')
    expect(node.data).toEqual({
      prompt: '雨夜霓虹街道，中景',
      model: 'openai:gpt-image-1',
      size: '1024x1536',
      outputs: { primary: { assetId: 'pa-1' } },
    })
    expect(round.warnings).toEqual([])
  })
})

describe('图片节点：归一化（§11.1 第 3 步）', () => {
  it('meta 携带 never 禁写的 label/episodeNo：剥离并警告', () => {
    const doc = serializeProject(contentWithImage(), 'p-1', NOW) as unknown as {
      graph: { nodes: Record<string, unknown>[] }
    }
    const raw = imageDocNode(doc)
    ;(raw.data as { meta: Record<string, unknown> }).meta = {
      label: '定妆图',
      episodeNo: 2,
    }
    const round = parseProject(doc)
    const node = round.content.nodes.find((n) => n.id === 'img1')!
    expect((node.data as Record<string, unknown>).name).toBeUndefined()
    expect(round.warnings.some((w) => w.includes('img1') && w.includes('label'))).toBe(true)
    expect(round.warnings.some((w) => w.includes('img1') && w.includes('episodeNo'))).toBe(true)
  })

  it('outputs 容器缺失重置为空对象、primary 引用异型剥离——均不隔离节点', () => {
    const doc = serializeProject(contentWithImage(), 'p-1', NOW) as unknown as {
      graph: { nodes: Record<string, unknown>[] }
    }
    delete (imageDocNode(doc).data as { spec: Record<string, unknown> }).spec.outputs
    const round = parseProject(doc)
    const node = round.content.nodes.find((n) => n.id === 'img1')!
    expect((node.data as { outputs: unknown }).outputs).toEqual({})
    expect(round.warnings.some((w) => w.includes('img1') && w.includes('outputs'))).toBe(true)

    const doc2 = serializeProject(contentWithImage(), 'p-1', NOW) as unknown as {
      graph: { nodes: Record<string, unknown>[] }
    }
    ;(imageDocNode(doc2).data as { spec: Record<string, unknown> }).spec.outputs = {
      primary: { assetId: 42 },
    }
    const round2 = parseProject(doc2)
    const node2 = round2.content.nodes.find((n) => n.id === 'img1')!
    expect((node2.data as { outputs: unknown }).outputs).toEqual({})
    expect(round2.warnings.some((w) => w.includes('img1') && w.includes('primary'))).toBe(true)
  })

  it('primary 的 assetId 悬空（资产已删）：保留引用并警告（§8.2.3 不自动清除）', () => {
    const content = contentWithImage()
    delete content.assets
    const doc = serializeProject(content, 'p-1', NOW)
    const round = parseProject(doc)
    const node = round.content.nodes.find((n) => n.id === 'img1')!
    expect((node.data as { outputs: { primary?: { assetId: string } } }).outputs.primary).toEqual({
      assetId: 'pa-1',
    })
    expect(round.warnings.some((w) => w.includes('img1') && w.includes('pa-1'))).toBe(true)
  })

  it('primary.assetId 空白且指向空键资产：随空键重发改写为新 id，而非剥离（§8.1）', () => {
    const doc = serializeProject(contentWithImage(), 'p-1', NOW) as unknown as {
      assets: { byId: Record<string, Record<string, unknown>> }
      graph: { nodes: Record<string, unknown>[] }
    }
    doc.assets.byId[''] = {
      id: '',
      relPath: 'assets/blank.png',
      mime: 'image/png',
      source: 'generated',
      createdAt: '2026-08-28T12:00:00.000Z',
    }
    const spec = (imageDocNode(doc).data as { spec: Record<string, unknown> }).spec
    ;(spec.outputs as { primary: { assetId: string } }).primary.assetId = ''
    const round = parseProject(doc)
    const node = round.content.nodes.find((n) => n.id === 'img1')!
    const primary = (node.data as { outputs: { primary?: { assetId: string } } }).outputs.primary
    expect(primary).toBeDefined()
    expect(primary?.assetId.trim()).not.toBe('')
    // 改写后仍指向重发回来的同一资产（新键）
    expect(round.content.assets?.byId[primary?.assetId ?? '']).toBeDefined()
    expect(round.warnings.some((w) => w.includes('img1') && w.includes('改写为新 id'))).toBe(true)
  })

  it('primary.assetId 空白且无空键资产映射：剥离并警告（同 avatarAssetId 口径）', () => {
    const doc = serializeProject(contentWithImage(), 'p-1', NOW) as unknown as {
      graph: { nodes: Record<string, unknown>[] }
    }
    const spec = (imageDocNode(doc).data as { spec: Record<string, unknown> }).spec
    ;(spec.outputs as { primary: { assetId: string } }).primary.assetId = '   '
    const round = parseProject(doc)
    const node = round.content.nodes.find((n) => n.id === 'img1')!
    expect((node.data as { outputs: { primary?: unknown } }).outputs.primary).toBeUndefined()
    expect(
      round.warnings.some((w) => w.includes('img1') && w.includes('无空键资产映射')),
    ).toBe(true)
  })

  it('必填标量异型（prompt 为对象）：节点隔离并警告', () => {
    const doc = serializeProject(contentWithImage(), 'p-1', NOW) as unknown as {
      graph: { nodes: Record<string, unknown>[] }
    }
    ;(imageDocNode(doc).data as { spec: Record<string, unknown> }).spec.prompt = { no: true }
    const round = parseProject(doc)
    expect(round.content.nodes.map((n) => n.id)).not.toContain('img1')
    expect(round.warnings.some((w) => w.includes('img1') && w.includes('prompt'))).toBe(true)
  })

  it('sequence/branch 边端点为图片节点：孤儿边隔离（图片节点不参与剧情流）', () => {
    const content = contentWithImage()
    content.edges = [
      { id: 'e-img', source: 's1', target: 'img1', className: 'pw-edge-sequence' } as never,
    ]
    const doc = serializeProject(content, 'p-1', NOW)
    const round = parseProject(doc)
    expect(round.content.edges).toEqual([])
    expect(round.warnings.some((w) => w.includes('e-img') || w.includes('孤儿边'))).toBe(true)
    // 节点本体保留
    expect(round.content.nodes.map((n) => n.id)).toContain('img1')
  })
})
