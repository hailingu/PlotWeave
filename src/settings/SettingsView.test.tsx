// @vitest-environment happy-dom
/**
 * 设置页组件测试：Provider 卡片编辑（启用/Base URL/模型清单）、
 * API key 提交与清除、默认模型三层过滤下拉与防抖落盘。
 * happy-dom 无 __TAURI_INTERNALS__，settingsStore 走内存回退路径。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import SettingsView from './SettingsView'
import { defaultSettings } from './types'
import { settingsStore } from './settingsStore'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

beforeEach(async () => {
  // 内存 store 是模块级单例：每个用例前重置为默认设置
  await settingsStore.save(defaultSettings())
})

const openaiKeyInput = () =>
  screen.getByLabelText('OpenAI 兼容 API key') as HTMLInputElement

describe('SettingsView Provider 分段', () => {
  it('加载默认设置：两个 provider 卡片、OpenAI 已启用、key 未配置', async () => {
    render(<SettingsView onClose={vi.fn()} />)
    await screen.findByText('OpenAI 兼容')
    expect(screen.getByText('火山引擎 Ark')).toBeTruthy()
    const toggles = screen.getAllByRole('checkbox') as HTMLInputElement[]
    expect(toggles[0].checked).toBe(true)
    expect(toggles[1].checked).toBe(true)
    expect(screen.getAllByText('未配置')).toHaveLength(2)
  })

  it('编辑即保存：取消勾选启用，防抖 500ms 后全量落盘', async () => {
    const saveSpy = vi.spyOn(settingsStore, 'save')
    render(<SettingsView onClose={vi.fn()} />)
    await screen.findByText('OpenAI 兼容')

    vi.useFakeTimers()
    const arkToggle = screen.getAllByRole('checkbox')[1]
    fireEvent.click(arkToggle)
    expect((arkToggle as HTMLInputElement).checked).toBe(false)
    expect(saveSpy).not.toHaveBeenCalled() // 防抖窗口内不落盘
    await act(async () => {
      vi.advanceTimersByTime(600)
    })
    expect(saveSpy).toHaveBeenCalledTimes(1)
    const saved = saveSpy.mock.calls[0][0]
    expect(saved.providers[1].enabled).toBe(false)
  })

  it('模型清单按行解析并过滤空行，可用组合进入默认模型下拉', async () => {
    render(<SettingsView onClose={vi.fn()} />)
    await screen.findByText('OpenAI 兼容')
    const arkModels = screen.getAllByRole('textbox').find(
      (el) => el.tagName === 'TEXTAREA' && el.closest('.settings-card')?.textContent?.includes('火山'),
    ) as HTMLTextAreaElement
    fireEvent.change(arkModels, { target: { value: 'doubao-pro\n\n  doubao-lite  \n' } })
    const select = screen.getByRole('combobox', { name: /AI 对话模型/ }) as HTMLSelectElement
    const options = Array.from(select.options).map((o) => o.value)
    expect(options).toContain('volcengine-ark:doubao-pro')
    expect(options).toContain('volcengine-ark:doubao-lite')
  })
})

describe('SettingsView 默认模型分段', () => {
  it('未选择时显示引导；选择后提示当前对话走向', async () => {
    render(<SettingsView onClose={vi.fn()} />)
    expect(await screen.findByText('尚未选择默认模型，AI 面板将显示引导。')).toBeTruthy()
    fireEvent.change(screen.getByRole('combobox', { name: /AI 对话模型/ }), {
      target: { value: 'openai:gpt-4o' },
    })
    expect(await screen.findByText('当前对话走 OpenAI 兼容 · gpt-4o。')).toBeTruthy()
  })

  it('500ms 防抖窗口内关闭设置：卸载冲刷未落盘的最后一次编辑', async () => {
    const saveSpy = vi.spyOn(settingsStore, 'save')
    const view = render(<SettingsView onClose={vi.fn()} />)
    await screen.findByText('OpenAI 兼容')
    vi.useFakeTimers()
    fireEvent.change(screen.getByRole('combobox', { name: /图像生成模型/ }), {
      target: { value: 'openai:gpt-4o' },
    })
    expect(saveSpy).not.toHaveBeenCalled() // 防抖窗口内不落盘
    view.unmount() // 点「完成」关闭设置 = 卸载
    await act(async () => {
      await Promise.resolve()
    })
    expect(saveSpy).toHaveBeenCalledTimes(1)
    expect(saveSpy.mock.calls[0][0].defaultImage).toBe('openai:gpt-4o')
  })

  it('点「完成」：先 await 冲刷落盘，再回调 onClose（界面切换不早于落盘）', async () => {
    let resolveSave!: (v: void) => void
    const saveSpy = vi.spyOn(settingsStore, 'save').mockImplementation(
      () => new Promise<void>((res) => (resolveSave = res)),
    )
    const onClose = vi.fn()
    render(<SettingsView onClose={onClose} />)
    await screen.findByText('OpenAI 兼容')
    fireEvent.change(screen.getByRole('combobox', { name: /图像生成模型/ }), {
      target: { value: 'openai:gpt-4o' },
    })
    fireEvent.click(screen.getByRole('button', { name: '关闭设置' }))
    await act(async () => {
      await Promise.resolve()
    })
    expect(saveSpy).toHaveBeenCalledTimes(1) // 防抖被撤、立即冲刷
    expect(onClose).not.toHaveBeenCalled() // 落盘完成前不切换界面
    await act(async () => {
      resolveSave()
      await Promise.resolve()
    })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('禁用所有 provider 后提示暂无可用模型', async () => {
    render(<SettingsView onClose={vi.fn()} />)
    await screen.findByText('OpenAI 兼容')
    for (const toggle of screen.getAllByRole('checkbox')) fireEvent.click(toggle)
    expect(
      await screen.findByText('暂无可用模型：请启用 provider、配置 API key 并添加模型 id。'),
    ).toBeTruthy()
  })
})

describe('SettingsView API key', () => {
  it('保存 key：状态变已配置、草稿清空；清除后回到未配置', async () => {
    render(<SettingsView onClose={vi.fn()} />)
    await screen.findByText('OpenAI 兼容')
    fireEvent.change(openaiKeyInput(), { target: { value: 'sk-test-123' } })
    fireEvent.click(screen.getAllByRole('button', { name: '保存' })[0])
    await screen.findByText('已配置')
    expect(openaiKeyInput().value).toBe('') // 不回显明文

    fireEvent.click(screen.getAllByRole('button', { name: '清除' })[0])
    await screen.findAllByText('未配置')
  })

  it('空白 key 不提交；加密失败显示错误', async () => {
    render(<SettingsView onClose={vi.fn()} />)
    await screen.findByText('OpenAI 兼容')
    fireEvent.change(openaiKeyInput(), { target: { value: '   ' } })
    fireEvent.click(screen.getAllByRole('button', { name: '保存' })[0])
    expect(screen.getAllByText('未配置')).toHaveLength(2) // 未触发提交

    const failSpy = vi
      .spyOn(settingsStore, 'setProviderKey')
      .mockRejectedValue(new Error('加密失败'))
    fireEvent.change(openaiKeyInput(), { target: { value: 'sk-x' } })
    fireEvent.keyDown(openaiKeyInput(), { key: 'Enter' })
    await screen.findByText(/加密失败/)
    expect(failSpy).toHaveBeenCalled()
  })
})

describe('SettingsView 关闭', () => {
  it('「完成」按钮触发 onClose（无 pending 编辑，冲刷 no-op 后即关）', async () => {
    const onClose = vi.fn()
    render(<SettingsView onClose={onClose} />)
    await screen.findByText('OpenAI 兼容')
    fireEvent.click(screen.getByRole('button', { name: '关闭设置' }))
    await act(async () => {
      await Promise.resolve()
    })
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
