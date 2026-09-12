// @vitest-environment happy-dom
/**
 * 左栏设定集「文档」分段与文档编辑器弹窗（issue 56）：
 * 列表渲染、新增/删除动作透传、打开编辑器、标题/正文编辑、
 * 关联角色/地点 chips 切换、保存派发 updateDocument、取消不派发。
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import LeftPanel, { type SettingsActions } from './LeftPanel'
import type { CanvasNode } from '../nodes/types'
import type { DocumentEntity } from '../settings'

afterEach(cleanup)

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn()
})

const nodes: CanvasNode[] = []

const DOC_A: DocumentEntity = {
  id: 'doc-1',
  title: '人物小传',
  body: '陈默，落魄侦探。',
  relatedIds: [{ kind: 'character', id: 'c1' }],
}
const DOC_B: DocumentEntity = { id: 'doc-2', title: '术语表', body: '', relatedIds: [] }

function setup(over: Partial<Parameters<typeof LeftPanel>[0]> = {}) {
  const settingsActions: SettingsActions = {
    addCharacter: vi.fn(),
    renameCharacter: vi.fn(),
    deleteCharacter: vi.fn(),
    addLocation: vi.fn(),
    renameLocation: vi.fn(),
    deleteLocation: vi.fn(),
    addDocument: vi.fn(),
    updateDocument: vi.fn(),
    deleteDocument: vi.fn(),
  }
  const spies = {
    onResize: vi.fn(),
    onLocate: vi.fn(),
    onFocusEpisode: vi.fn(),
    onRenameEpisode: vi.fn(),
    onOutlineDrop: vi.fn(),
    settingsActions,
  }
  render(
    <LeftPanel
      open
      width={280}
      nodes={nodes}
      edges={[]}
      settings={{
        characters: [{ id: 'c1', name: '陈默', gradient: 'g1' }],
        locations: [{ id: 'l1', name: '茶馆' }],
        documents: [DOC_A, DOC_B],
      }}
      episodeTitles={{}}
      focusedEpisode={null}
      {...spies}
      {...over}
    />,
  )
  return spies
}

const toSettingsTab = () => {
  fireEvent.click(screen.getByRole('button', { name: '设定集' }))
}

describe('LeftPanel 文档列表（issue 56）', () => {
  it('渲染文档条目（标题）与新增/删除动作透传', () => {
    const spies = setup()
    toSettingsTab()
    expect(screen.getByRole('button', { name: '打开文档 人物小传' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '打开文档 术语表' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '＋ 新增文档' }))
    expect(spies.settingsActions.addDocument).toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '删除文档 人物小传' }))
    expect(spies.settingsActions.deleteDocument).toHaveBeenCalledWith('doc-1')
  })

  it('点击文档行打开编辑器：回填标题与正文，未派发任何改动', () => {
    const spies = setup()
    toSettingsTab()
    fireEvent.click(screen.getByRole('button', { name: '打开文档 人物小传' }))
    expect(screen.getByRole('dialog', { name: '编辑设定文档' })).toBeTruthy()
    expect(screen.getByDisplayValue('人物小传')).toBeTruthy()
    expect(screen.getByDisplayValue('陈默，落魄侦探。')).toBeTruthy()
    expect(spies.settingsActions.updateDocument).not.toHaveBeenCalled()
  })

  it('编辑器弹窗经 portal 挂到 document.body：不落在 .pw-panel 裁剪上下文内（PR #86 评审）', () => {
    setup()
    toSettingsTab()
    fireEvent.click(screen.getByRole('button', { name: '打开文档 人物小传' }))
    const dialog = screen.getByRole('dialog', { name: '编辑设定文档' })
    const overlay = dialog.closest('.pw-overlay')!
    expect(overlay.parentElement).toBe(document.body)
    expect(document.querySelector('.pw-panel-left')?.contains(overlay)).toBe(false)
  })
})

describe('文档编辑器弹窗（issue 56）', () => {
  const openEditor = () => {
    toSettingsTab()
    fireEvent.click(screen.getByRole('button', { name: '打开文档 术语表' }))
  }

  it('编辑标题与正文后保存：一次 updateDocument 派发整体编辑态并关闭', () => {
    const spies = setup()
    openEditor()
    fireEvent.change(screen.getByLabelText('文档标题'), { target: { value: '术语总表' } })
    fireEvent.change(screen.getByLabelText('文档正文'), { target: { value: '术语 A。' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    expect(spies.settingsActions.updateDocument).toHaveBeenCalledTimes(1)
    expect(spies.settingsActions.updateDocument).toHaveBeenCalledWith('doc-2', {
      title: '术语总表',
      body: '术语 A。',
      relatedIds: [],
    })
    expect(screen.queryByRole('dialog', { name: '编辑设定文档' })).toBeNull()
  })

  it('关联 chips：点击角色/地点切换 relatedIds；已关联高亮', () => {
    const spies = setup()
    openEditor()
    // 术语表未关联任何人：两个 chip 均未选中
    const chChip = screen.getByRole('button', { name: '关联角色 陈默' })
    const locChip = screen.getByRole('button', { name: '关联地点 茶馆' })
    expect(chChip.getAttribute('aria-pressed')).toBe('false')
    fireEvent.click(chChip)
    fireEvent.click(locChip)
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    expect(spies.settingsActions.updateDocument).toHaveBeenCalledWith('doc-2', {
      title: '术语表',
      body: '',
      relatedIds: [
        { kind: 'character', id: 'c1' },
        { kind: 'location', id: 'l1' },
      ],
    })
  })

  it('已关联 chip 高亮；取消勾选后保存移除关联', () => {
    const spies = setup()
    toSettingsTab()
    fireEvent.click(screen.getByRole('button', { name: '打开文档 人物小传' }))
    const chChip = screen.getByRole('button', { name: '关联角色 陈默' })
    expect(chChip.getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(chChip)
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    expect(spies.settingsActions.updateDocument).toHaveBeenCalledWith('doc-1', {
      title: '人物小传',
      body: '陈默，落魄侦探。',
      relatedIds: [],
    })
  })

  it('Esc 关闭不保存；改动不派发', () => {
    const spies = setup()
    openEditor()
    fireEvent.change(screen.getByLabelText('文档正文'), { target: { value: '改了但不存。' } })
    fireEvent.keyDown(screen.getByRole('dialog', { name: '编辑设定文档' }), { key: 'Escape' })
    expect(screen.queryByRole('dialog', { name: '编辑设定文档' })).toBeNull()
    expect(spies.settingsActions.updateDocument).not.toHaveBeenCalled()
  })
})
