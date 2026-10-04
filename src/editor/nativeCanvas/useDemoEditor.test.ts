// @vitest-environment happy-dom
/** 演示编辑会话的可观察结果；约束阶段提交前的职责拆分不改变图和面板状态。 */
import { act, renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { useDemoEditor } from './useDemoEditor'
import { SCENE_SHOT_HANDLE } from '../graphRules'

describe('演示节点编辑', () => {
  it('编辑与复制保留源节点，删除同步清理关联边和设置面板', () => {
    const { result, unmount } = renderHook(useDemoEditor)
    act(() => result.current.nodeEditApi.toggleSettings('demo-scene-roof'))
    expect(result.current.nodeEditApi.openSettingsId).toBe('demo-scene-roof')
    act(() => result.current.nodeEditApi.duplicateNode('demo-scene-roof'))
    const copy = result.current.nodes.find((node) => node.selected)
    expect(copy).toMatchObject({
      type: 'scene',
      position: { x: 352, y: 12 },
      data: { name: '天台对峙' },
    })
    expect(copy?.id).not.toBe('demo-scene-roof')
    expect(result.current.nodes).toHaveLength(10)
    act(() => result.current.nodeEditApi.deleteNode('demo-scene-roof'))
    expect(
      result.current.nodes.some((node) => node.id === 'demo-scene-roof'),
    ).toBe(false)
    expect(
      result.current.edges.some(
        (edge) =>
          edge.source === 'demo-scene-roof' ||
          edge.target === 'demo-scene-roof',
      ),
    ).toBe(false)
    expect(result.current.nodeEditApi.openSettingsId).toBeNull()
    expect(result.current.nodeEditApi.shotCountOf('demo-scene-roof')).toBe(0)
    unmount()
  })

  it('设置开关、派生计数与未知节点操作保持一致', () => {
    const { result, unmount } = renderHook(useDemoEditor)
    expect(result.current.nodeEditApi.shotCountOf('demo-scene-roof')).toBe(1)
    expect(
      result.current.nodeEditApi.beatFulfillmentOf('demo-beat-open'),
    ).not.toBeNull()
    expect(
      result.current.nodeEditApi.beatFulfillmentOf('demo-image-1'),
    ).toBeNull()
    act(() => result.current.nodeEditApi.toggleSettings('demo-image-1'))
    act(() => result.current.nodeEditApi.toggleSettings('demo-image-1'))
    expect(result.current.nodeEditApi.openSettingsId).toBeNull()
    act(() => result.current.nodeEditApi.toggleSettings('demo-image-1'))
    act(() => result.current.nodeEditApi.closeSettings())
    expect(result.current.nodeEditApi.openSettingsId).toBeNull()
    act(() => result.current.nodeEditApi.duplicateNode('missing'))
    expect(result.current.nodes).toHaveLength(9)
    unmount()
  })
})

describe('演示连线', () => {
  it('拒绝自环、重复、成环和重复宿主，新增合法边后刷新校验', () => {
    const { result, unmount } = renderHook(useDemoEditor)
    const connect = {
      source: 'demo-beat-b',
      target: 'demo-scene-tea',
      sourceHandle: null,
      targetHandle: null,
    }
    expect(
      result.current.isValidConnection({ ...connect, target: connect.source }),
    ).toBe(false)
    expect(
      result.current.isValidConnection({ ...connect, source: 'demo-beat-a' }),
    ).toBe(false)
    expect(
      result.current.isValidConnection({
        ...connect,
        source: 'demo-scene-tea',
        target: 'demo-beat-a',
      }),
    ).toBe(false)
    expect(
      result.current.isValidConnection({
        ...connect,
        source: 'demo-scene-tea',
        target: 'demo-shot-1',
        sourceHandle: SCENE_SHOT_HANDLE,
      }),
    ).toBe(false)
    expect(result.current.isValidConnection(connect)).toBe(true)
    act(() => result.current.onConnect(connect))
    expect(result.current.edges).toHaveLength(8)
    expect(result.current.edges[result.current.edges.length - 1]).toMatchObject(
      {
        source: connect.source,
        target: connect.target,
        className: 'pw-edge-sequence',
      },
    )
    expect(result.current.isValidConnection(connect)).toBe(false)
    unmount()
  })
})

it('字段补丁仅更新目标节点并保留未指定字段', () => {
  const { result, unmount } = renderHook(useDemoEditor)
  act(() =>
    result.current.nodeEditApi.patchNode('demo-beat-open', {
      nodeType: 'beat',
      patch: { name: '新的开端' },
    }),
  )
  expect(
    result.current.nodes.find((node) => node.id === 'demo-beat-open')?.data,
  ).toMatchObject({ name: '新的开端', tone: '克制' })
  expect(
    result.current.nodes.find((node) => node.id === 'demo-scene-roof')?.data
      .name,
  ).toBe('天台对峙')
  unmount()
})
