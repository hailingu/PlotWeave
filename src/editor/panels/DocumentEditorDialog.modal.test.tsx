// @vitest-environment happy-dom
/** #595：真实文档弹窗与应用设置快捷键共享模态边界，草稿不会被快捷键卸载。 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useState } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import {
  DocumentEditorDialog,
  type DocumentSavePatch,
} from './DocumentEditorDialog'
import { useAppSettingsShortcut } from '../../useAppSettingsShortcut'

afterEach(() => {
  cleanup()
  document.body.replaceChildren()
})

const doc = { id: 'doc', title: '人物小传', body: '原文', relatedIds: [] }
const settings = { characters: [], locations: [] }

/** 共享快捷键实际切换界面，若模态边界失效就卸载弹窗并丢失本地草稿。 */
function ModalRoute({
  onSave,
}: {
  readonly onSave: (id: string, patch: DocumentSavePatch) => void
}) {
  const [editing, setEditing] = useState(true)
  const [settingsOpen, setSettingsOpen] = useState(false)
  useAppSettingsShortcut(() => setSettingsOpen(true))
  if (settingsOpen) return <div>应用设置</div>
  return (
    <>
      <button type="button" onClick={() => setEditing(true)}>
        打开文档
      </button>
      {editing && (
        <DocumentEditorDialog
          doc={doc}
          settings={settings}
          onSave={onSave}
          onClose={() => setEditing(false)}
        />
      )}
    </>
  )
}

/** 先聚焦背景触发按钮，再打开真实弹窗，便于核实焦点归还。 */
function setup() {
  const trigger = document.createElement('button')
  document.body.appendChild(trigger)
  trigger.focus()
  const onSave = vi.fn()
  const view = render(<ModalRoute onSave={onSave} />)
  return { ...view, onSave, trigger }
}

const closeButton = () => screen.getByRole('button', { name: '关闭' })
const saveButton = () => screen.getByRole('button', { name: '保存' })
const dialog = () => screen.getByRole('dialog', { name: '编辑设定文档' })

describe('DocumentEditorDialog 草稿与设置快捷键（#595）', () => {
  it.each([{ metaKey: true }, { ctrlKey: true }])(
    '未保存草稿在设置快捷键 %j 后仍保留在同一编辑会话',
    (modifier) => {
      const { onSave } = setup()
      fireEvent.change(screen.getByLabelText('文档标题'), {
        target: { value: '未保存标题' },
      })
      fireEvent.change(screen.getByLabelText('文档正文'), {
        target: { value: '未保存长文' },
      })
      fireEvent.keyDown(screen.getByLabelText('文档正文'), {
        key: ',',
        ...modifier,
      })
      expect(screen.queryByText('应用设置')).toBeNull()
      expect(dialog().getAttribute('aria-modal')).toBe('true')
      expect(screen.getByDisplayValue('未保存标题')).toBeTruthy()
      expect(screen.getByDisplayValue('未保存长文')).toBeTruthy()
      expect(onSave).not.toHaveBeenCalled()
      fireEvent.click(closeButton())
      fireEvent.keyDown(document, { key: ',', ...modifier })
      expect(screen.getByText('应用设置')).toBeTruthy()
    },
  )
})

describe('DocumentEditorDialog 焦点圈定（#595）', () => {
  it('挂载即进入首控件，编辑重渲染不夺走正文焦点', () => {
    const { rerender } = setup()
    expect(document.activeElement).toBe(closeButton())
    const body = screen.getByLabelText('文档正文')
    body.focus()
    fireEvent.change(body, { target: { value: '草稿' } })
    rerender(<ModalRoute onSave={vi.fn()} />)
    expect(document.activeElement).toBe(body)
  })

  it('首尾 Tab 环绕；禁用保存时跳过该控件', () => {
    setup()
    saveButton().focus()
    fireEvent.keyDown(saveButton(), { key: 'Tab' })
    expect(document.activeElement).toBe(closeButton())
    fireEvent.keyDown(closeButton(), { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(saveButton())
    fireEvent.change(screen.getByLabelText('文档标题'), {
      target: { value: ' ' },
    })
    closeButton().focus()
    fireEvent.keyDown(closeButton(), { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(screen.getByLabelText('文档正文'))
  })

  it.each([false, true])(
    '背景误获焦点时按 Tab（shift=%s）拉回弹窗',
    (shiftKey) => {
      const { trigger } = setup()
      trigger.focus()
      fireEvent.keyDown(trigger, { key: 'Tab', shiftKey })
      expect(document.activeElement).toBe(
        shiftKey ? saveButton() : closeButton(),
      )
    },
  )
})

describe('DocumentEditorDialog 关闭与组合输入（#595）', () => {
  it.each(['Escape', '关闭', '遮罩', '保存'])(
    '%s 关闭后归还焦点，仅保存提交草稿',
    (path) => {
      const { onSave, trigger } = setup()
      fireEvent.change(screen.getByLabelText('文档正文'), {
        target: { value: '草稿' },
      })
      if (path === 'Escape') fireEvent.keyDown(dialog(), { key: 'Escape' })
      else if (path === '遮罩') fireEvent.pointerDown(dialog().parentElement!)
      else fireEvent.click(screen.getByRole('button', { name: path }))
      expect(screen.queryByRole('dialog')).toBeNull()
      expect(document.activeElement).toBe(trigger)
      if (path === '保存')
        expect(onSave).toHaveBeenCalledWith('doc', {
          title: '人物小传',
          body: '草稿',
          relatedIds: [],
        })
      else expect(onSave).not.toHaveBeenCalled()
    },
  )

  it.each([{ isComposing: true }, { keyCode: 229 }])(
    '组合键 %j 的 Esc 保留草稿，普通 Esc 关闭',
    (composition) => {
      setup()
      fireEvent.change(screen.getByLabelText('文档正文'), {
        target: { value: '输入中' },
      })
      fireEvent.keyDown(screen.getByLabelText('文档正文'), {
        key: 'Escape',
        ...composition,
      })
      expect(screen.getByDisplayValue('输入中')).toBeTruthy()
      fireEvent.keyDown(screen.getByLabelText('文档正文'), { key: 'Escape' })
      expect(screen.queryByRole('dialog')).toBeNull()
    },
  )
})
