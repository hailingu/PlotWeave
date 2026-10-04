// @vitest-environment happy-dom
/**
 * 左栏设定集「文档」分段与文档编辑器弹窗（issue 56）：
 * 列表渲染、新增/删除动作透传、打开编辑器、标题/正文编辑、
 * 关联角色/地点 chips 切换、保存派发 updateDocument、取消不派发。
 * issue #126：弹窗状态提升到父层（宿主模拟 EditorLayout 持有
 * editingDocId），底层文档经 props 变化时草稿协调——未编辑跟随、
 * 已编辑保留、文档删除即关闭。
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { useState } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { LeftPanel } from './LeftPanel'
import type { SettingsActions } from './settingsActions'
import type { CanvasNode } from '../nodes/types'
import type { DocumentEntity, ProjectSettings } from '../settings'

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
const DOC_B: DocumentEntity = {
  id: 'doc-2',
  title: '术语表',
  body: '',
  relatedIds: [],
}

const SETTINGS: ProjectSettings = {
  characters: [{ id: 'c1', name: '陈默', gradient: 'g1' }],
  locations: [{ id: 'l1', name: '茶馆' }],
  documents: [DOC_A, DOC_B],
}

type PanelProps = Parameters<typeof LeftPanel>[0]

/** 测试 spy 集：动作回调 + 设定集动作桶（LeftPanel 必需 props 的子集）。 */
type PanelSpies = Pick<
  PanelProps,
  | 'onResize'
  | 'onLocate'
  | 'onFocusEpisode'
  | 'onRenameEpisode'
  | 'onOutlineDrop'
  | 'settingsActions'
>

function mkSpies(): PanelSpies {
  const settingsActions: SettingsActions = {
    addCharacter: vi.fn(),
    renameCharacter: vi.fn(),
    deleteCharacter: vi.fn(),
    updateCharacter: vi.fn(),
    addLocation: vi.fn(),
    renameLocation: vi.fn(),
    deleteLocation: vi.fn(),
    updateLocation: vi.fn(),
    addDocument: vi.fn(),
    updateDocument: vi.fn(),
    deleteDocument: vi.fn(),
  }
  return {
    onResize: vi.fn(),
    onLocate: vi.fn(),
    onFocusEpisode: vi.fn(),
    onRenameEpisode: vi.fn(),
    onOutlineDrop: vi.fn(),
    settingsActions,
  }
}

/** 测试宿主（issue #126）：弹窗状态提升后由父层持有 editingDocId，
 * 在 rerender（settings 可替换）间保持弹窗挂载状态；探针暴露当前 id，
 * 供断言「文档消失后挂载 id 被清空」（PR #185 评审）。 */
function DocPanelHost({
  settings,
  spies,
}: {
  readonly settings: ProjectSettings
  readonly spies: PanelSpies
}) {
  const [editingDocId, setEditingDocId] = useState<string | null>(null)
  return (
    <>
      <div data-testid="doc-dialog-id">{editingDocId ?? 'null'}</div>
      <LeftPanel
        open
        width={280}
        nodes={nodes}
        contentNodes={nodes}
        edges={[]}
        settings={settings}
        episodeTitles={{}}
        focusedEpisode={null}
        docDialog={{
          editingDocId,
          open: setEditingDocId,
          close: () => setEditingDocId(null),
        }}
        {...spies}
      />
    </>
  )
}

function setup(settings: ProjectSettings = SETTINGS) {
  const spies = mkSpies()
  const view = render(<DocPanelHost settings={settings} spies={spies} />)
  return {
    spies,
    /** 模拟父层收到新 settings（全局撤销/重做/外部更新后的净效果）。 */
    rerender: (next: ProjectSettings) =>
      view.rerender(<DocPanelHost settings={next} spies={spies} />),
  }
}

const toSettingsTab = () => {
  fireEvent.click(screen.getByRole('button', { name: '设定集' }))
}

describe('LeftPanel 文档列表（issue 56）', () => {
  it('渲染文档条目（标题）与新增/删除动作透传', () => {
    const { spies } = setup()
    toSettingsTab()
    expect(
      screen.getByRole('button', { name: '打开文档 人物小传' }),
    ).toBeTruthy()
    expect(screen.getByRole('button', { name: '打开文档 术语表' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '＋ 新增文档' }))
    expect(spies.settingsActions.addDocument).toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '删除文档 人物小传' }))
    expect(spies.settingsActions.deleteDocument).toHaveBeenCalledWith('doc-1')
  })

  it('点击文档行打开编辑器：回填标题与正文，未派发任何改动', () => {
    const { spies } = setup()
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
    expect(document.querySelector('.pw-panel-left')?.contains(overlay)).toBe(
      false,
    )
  })
})

describe('文档编辑器弹窗（issue 56）', () => {
  const openEditor = () => {
    toSettingsTab()
    fireEvent.click(screen.getByRole('button', { name: '打开文档 术语表' }))
  }

  it('编辑标题与正文后保存：一次 updateDocument 派发整体编辑态并关闭', () => {
    const { spies } = setup()
    openEditor()
    fireEvent.change(screen.getByLabelText('文档标题'), {
      target: { value: '术语总表' },
    })
    fireEvent.change(screen.getByLabelText('文档正文'), {
      target: { value: '术语 A。' },
    })
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
    const { spies } = setup()
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
    const { spies } = setup()
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
    const { spies } = setup()
    openEditor()
    fireEvent.change(screen.getByLabelText('文档正文'), {
      target: { value: '改了但不存。' },
    })
    fireEvent.keyDown(screen.getByRole('dialog', { name: '编辑设定文档' }), {
      key: 'Escape',
    })
    expect(screen.queryByRole('dialog', { name: '编辑设定文档' })).toBeNull()
    expect(spies.settingsActions.updateDocument).not.toHaveBeenCalled()
  })
})

describe('文档弹窗与底层文档协调（issue #126）', () => {
  it('草稿未编辑时底层文档更新：三字段跟随新值，保存提交新值不写回陈旧草稿', () => {
    const { spies, rerender } = setup()
    toSettingsTab()
    fireEvent.click(screen.getByRole('button', { name: '打开文档 术语表' }))
    // 模拟全局撤销/外部更新后的 settings：doc-2 整体回到旧值并新增关联
    const undone: DocumentEntity = {
      id: 'doc-2',
      title: '旧术语表',
      body: '被撤销前的正文。',
      relatedIds: [{ kind: 'character', id: 'c1' }],
    }
    rerender({ ...SETTINGS, documents: [DOC_A, undone] })
    expect(screen.getByDisplayValue('旧术语表')).toBeTruthy()
    expect(screen.getByDisplayValue('被撤销前的正文。')).toBeTruthy()
    expect(
      screen
        .getByRole('button', { name: '关联角色 陈默' })
        .getAttribute('aria-pressed'),
    ).toBe('true')
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    expect(spies.settingsActions.updateDocument).toHaveBeenCalledWith('doc-2', {
      title: '旧术语表',
      body: '被撤销前的正文。',
      relatedIds: [{ kind: 'character', id: 'c1' }],
    })
  })

  it('草稿已编辑后底层文档更新：保留用户输入，保存提交用户草稿', () => {
    const { spies, rerender } = setup()
    toSettingsTab()
    fireEvent.click(screen.getByRole('button', { name: '打开文档 术语表' }))
    fireEvent.change(screen.getByLabelText('文档正文'), {
      target: { value: '我的未保存草稿。' },
    })
    rerender({
      ...SETTINGS,
      documents: [
        DOC_A,
        { ...DOC_B, title: '外部新标题', body: '外部新正文。' },
      ],
    })
    expect(screen.getByDisplayValue('我的未保存草稿。')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    expect(spies.settingsActions.updateDocument).toHaveBeenCalledWith('doc-2', {
      title: '术语表',
      body: '我的未保存草稿。',
      relatedIds: [],
    })
  })

  it('底层文档被删除：弹窗自动关闭且不派发保存', () => {
    const { spies, rerender } = setup()
    toSettingsTab()
    fireEvent.click(screen.getByRole('button', { name: '打开文档 术语表' }))
    rerender({ ...SETTINGS, documents: [DOC_A] })
    expect(screen.queryByRole('dialog', { name: '编辑设定文档' })).toBeNull()
    expect(spies.settingsActions.updateDocument).not.toHaveBeenCalled()
  })

  it('底层文档被删除后挂载 id 被清空：模态会话结束，全局快捷键可恢复（PR #185 评审）', () => {
    const { spies, rerender } = setup()
    toSettingsTab()
    fireEvent.click(screen.getByRole('button', { name: '打开文档 术语表' }))
    expect(screen.getByTestId('doc-dialog-id').textContent).toBe('doc-2')
    rerender({ ...SETTINGS, documents: [DOC_A] })
    expect(screen.getByTestId('doc-dialog-id').textContent).toBe('null')
    expect(spies.settingsActions.updateDocument).not.toHaveBeenCalled()
  })
})
