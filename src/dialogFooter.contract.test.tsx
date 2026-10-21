// @vitest-environment happy-dom
/** #664：四个真实调用方的页脚结构与动作基线；抽取不得改变交互。 */
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { RenameDialog, ConfirmDeleteDialog } from './home/Dialogs'
import { ExportDialog } from './editor/ExportDialog'
import { buildScriptExport } from './editor/exportScript'
import { DocumentEditorDialog } from './editor/panels/DocumentEditorDialog'
import { EMPTY_SETTINGS } from './editor/settings'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

/** 页脚的实际直接子元素保持 CSS/焦点顺序，不通过组件内部状态取值。 */
function footer() {
  const node = screen.getByRole('dialog').querySelector('.pw-dialog-foot')
  if (!(node instanceof HTMLElement)) throw new Error('缺少页脚')
  expect(node.querySelectorAll('.pw-sp')).toHaveLength(1)
  for (const button of node.querySelectorAll('button'))
    expect(button.type).toBe('button')
  return node
}

it('重命名保留取消/主操作顺序、空名禁用与输入焦点', () => {
  const confirm = vi.fn()
  const cancel = vi.fn()
  render(
    <RenameDialog currentName="旧名称" onConfirm={confirm} onCancel={cancel} />,
  )
  const input = screen.getByRole('textbox', { name: '项目名' })
  expect(document.activeElement).toBe(input)
  const buttons = within(footer()).getAllByRole('button')
  expect(buttons.map((b) => [b.textContent?.trim(), b.className])).toEqual([
    ['取消', 'pw-dialog-btn'],
    ['重命名', 'pw-dialog-btn pw-dialog-btn-primary'],
  ])
  expect(Array.from(footer().children).map((n) => n.tagName)).toEqual([
    'SPAN',
    'BUTTON',
    'BUTTON',
  ])
  fireEvent.change(input, { target: { value: ' ' } })
  expect((buttons[1] as HTMLButtonElement).disabled).toBe(true)
  fireEvent.change(input, { target: { value: ' 新名称 ' } })
  fireEvent.keyDown(input, { key: 'Enter', isComposing: true })
  expect(confirm).not.toHaveBeenCalled()
  fireEvent.click(buttons[1]!)
  expect(confirm).toHaveBeenCalledExactlyOnceWith('新名称')
  fireEvent.click(buttons[0]!)
  expect(cancel).toHaveBeenCalledTimes(1)
})

it('删除确认保留危险样式与单次确认/取消回调', () => {
  const confirm = vi.fn()
  const cancel = vi.fn()
  render(
    <ConfirmDeleteDialog
      title="删除项目"
      message="删除后不可恢复"
      onConfirm={confirm}
      onCancel={cancel}
    />,
  )
  const buttons = within(footer()).getAllByRole('button')
  expect(buttons.map((b) => [b.textContent?.trim(), b.className])).toEqual([
    ['取消', 'pw-dialog-btn'],
    ['删除', 'pw-dialog-btn pw-dialog-danger'],
  ])
  fireEvent.click(buttons[1]!)
  expect(confirm).toHaveBeenCalledTimes(1)
  expect(cancel).not.toHaveBeenCalled()
  fireEvent.click(buttons[0]!)
  expect(cancel).toHaveBeenCalledTimes(1)
})

it('导出保留控制区与复制/下载顺序，复制回执不重挂按钮', async () => {
  const writeText = vi.fn().mockResolvedValue(undefined)
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText },
  })
  const model = buildScriptExport({
    projectName: '合同',
    nodes: [],
    edges: [],
    settings: EMPTY_SETTINGS,
    assets: undefined,
    episodeTitles: {},
  })
  render(
    <ExportDialog
      projectName="合同"
      model={model}
      json='{"schemaVersion":1}'
      onClose={vi.fn()}
    />,
  )
  expect(footer().className).toBe('pw-dialog-foot pw-export-foot')
  const copy = within(footer()).getByRole('button', { name: '复制全文' })
  expect(copy.className).toBe('pw-dialog-btn')
  fireEvent.change(screen.getByRole('combobox', { name: '导出格式' }), {
    target: { value: 'json' },
  })
  expect(
    within(footer()).getByRole('button', { name: '下载 .json' }).className,
  ).toBe('pw-dialog-btn pw-dialog-btn-primary')
  fireEvent.click(copy)
  expect(
    await within(footer()).findByRole('button', { name: '✓ 已复制' }),
  ).toBe(copy)
  expect(writeText).toHaveBeenCalledExactlyOnceWith('{"schemaVersion":1}')
  expect(
    Array.from(footer().children)
      .slice(-3)
      .map((n) => n.tagName),
  ).toEqual(['SPAN', 'BUTTON', 'BUTTON'])
})

it('文档页脚只有保存主操作，禁用与保存/关闭仍属于原草稿所有者', () => {
  const save = vi.fn()
  const close = vi.fn()
  render(
    <DocumentEditorDialog
      doc={{ id: 'doc', title: '旧标题', body: '正文', relatedIds: [] }}
      settings={EMPTY_SETTINGS}
      onSave={save}
      onClose={close}
    />,
  )
  const title = screen.getByDisplayValue('旧标题')
  const button = within(footer()).getByRole('button', {
    name: '保存',
  }) as HTMLButtonElement
  expect(button.className).toBe('pw-dialog-btn pw-dialog-btn-primary')
  expect(within(footer()).getAllByRole('button')).toEqual([button])
  expect(Array.from(footer().children).map((n) => n.tagName)).toEqual([
    'SPAN',
    'SPAN',
    'BUTTON',
  ])
  fireEvent.change(title, { target: { value: ' ' } })
  expect(button.disabled).toBe(true)
  fireEvent.change(title, { target: { value: '新标题' } })
  fireEvent.click(button)
  expect(save).toHaveBeenCalledExactlyOnceWith('doc', {
    title: '新标题',
    body: '正文',
    relatedIds: [],
  })
  expect(close).toHaveBeenCalledTimes(1)
})
