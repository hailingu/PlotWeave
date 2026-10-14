// @vitest-environment happy-dom
/**
 * App 首页变更域测试（issue #525 自 App.test.tsx 拆分）：重命名/删除/
 * 复制/创建的失败横幅反馈（issue #132）、创建族失败对账与并发归属
 * （PR #199 评审：部分提交不给盲重试、对账按尝试归属、结果未知保留
 * 诊断）。子视图与 projectStore 桩经 appShellTestScaffolding 委托。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { App } from './App'
import {
  DOC,
  afterAppShellTest,
  expectConsoleWarn,
  homeProps,
  resetAppShellFixture,
  store,
} from './appShellTestScaffolding'

vi.mock('./projectStore', async () =>
  (await import('./appShellTestScaffolding')).projectStoreMockModule(),
)
vi.mock('./home/HomePage', async () =>
  (await import('./appShellTestScaffolding')).homePageMockModule(),
)
vi.mock('./editor/EditorView', async () =>
  (await import('./appShellTestScaffolding')).editorViewMockModule(),
)
vi.mock('./settings/SettingsView', async () =>
  (await import('./appShellTestScaffolding')).settingsViewMockModule(),
)

afterEach(afterAppShellTest)

beforeEach(() => resetAppShellFixture())

describe('App ✦首页项目变更失败反馈：重命名与删除/复制（issue #132）', () => {
  it('重命名失败：横幅点名动作、目标与诊断；重试成功后横幅消失', async () => {
    expectConsoleWarn()
    store.load.mockResolvedValue(structuredClone(DOC))
    store.save.mockRejectedValueOnce(new Error('只读目录'))
    render(<App />)
    await screen.findByTestId('home')
    await act(async () => {
      await (
        homeProps.current.onRenameProject as (
          id: string,
          name: string,
        ) => Promise<void>
      )('p1', '新名')
    })
    expect(await screen.findByText(/rename:新名:只读目录/)).toBeTruthy()
    fireEvent.click(screen.getByTestId('retry-mutation'))
    await vi.waitFor(() => expect(store.save).toHaveBeenCalledTimes(2))
    await vi.waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
  })

  it('删除/复制失败：目标以项目 id 归属；重试生效后横幅消失', async () => {
    expectConsoleWarn()
    store.delete.mockRejectedValueOnce(new Error('io'))
    render(<App />)
    await screen.findByTestId('home')
    await act(async () => {
      await (
        homeProps.current.onDeleteProject as (id: string) => Promise<void>
      )('p1')
    })
    expect(await screen.findByText(/delete:p1:io/)).toBeTruthy()
    fireEvent.click(screen.getByTestId('retry-mutation'))
    await vi.waitFor(() => expect(store.delete).toHaveBeenCalledTimes(2))
    await vi.waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
  })
})

describe('App ✦创建失败反馈与结果对账（issue #132/PR #199 评审）', () => {
  it('创建失败：横幅点名尝试名称；重试成功后进入编辑器且无失败横幅', async () => {
    expectConsoleWarn()
    store.create.mockRejectedValueOnce(new Error('磁盘满'))
    render(<App />)
    await screen.findByTestId('home')
    await act(async () => {
      await (homeProps.current.onCreateProject as () => Promise<void>)()
    })
    expect(await screen.findByText(/create:未命名短剧:磁盘满/)).toBeTruthy()
    fireEvent.click(screen.getByTestId('retry-mutation'))
    await vi.waitFor(() => expect(store.create).toHaveBeenCalledTimes(2))
    await screen.findByTestId('editor')
    expect(homeProps.current.mutationError).toBeNull()
  })

  it('创建成功但随后打开失败：变更不虚报失败，打开失败走 #98 横幅', async () => {
    expectConsoleWarn()
    store.create.mockResolvedValue({ id: 'new-1', name: '未命名短剧' })
    store.duplicate.mockResolvedValue({ id: 'copy-1', name: '雨夜 副本' })
    store.load.mockRejectedValueOnce(new Error('打开失败'))
    render(<App />)
    await screen.findByTestId('home')
    await act(async () => {
      await (homeProps.current.onCreateProject as () => Promise<void>)()
    })
    expect(await screen.findByText(/打开失败/)).toBeTruthy()
    expect(homeProps.current.mutationError).toBeNull()
  })
})

describe('App ✦创建族失败对账（PR #199 评审）', () => {
  it('创建被拒但项目已实际存在（fsync 失败/应答丢失）：对账为已创建，不横幅不盲重试', async () => {
    expectConsoleWarn()
    const projects = [{ id: 'p1', name: '雨夜' }]
    store.list.mockImplementation(async () => [...projects])
    store.create.mockImplementationOnce(async () => {
      projects.push({ id: 'new-9', name: '未命名短剧' })
      throw new Error('目录 fsync 失败')
    })
    render(<App />)
    await screen.findByTestId('home')
    await act(async () => {
      await (homeProps.current.onCreateProject as () => Promise<void>)()
    })
    expect(homeProps.current.projects).toEqual(projects)
    expect(homeProps.current.mutationError).toBeNull()
    expect(screen.queryByTestId('retry-mutation')).toBeNull()
    expect(store.create).toHaveBeenCalledTimes(1)
  })

  it('并发创建：他次尝试的产出不被本次失败认领（对账按尝试归属）', async () => {
    expectConsoleWarn()
    let createCalls = 0
    let firstCommitted = false
    store.create.mockImplementation(() => {
      createCalls += 1
      if (createCalls === 1) {
        // 第一次：提交成功（产出 c1，随后列表可见）
        firstCommitted = true
        return Promise.resolve({ id: 'c1', name: '未命名短剧' })
      }
      // 第二次：确未创建（如磁盘满）
      return Promise.reject(new Error('磁盘满'))
    })
    // 两次打开都失败：首页保持可见，横幅可断言（#98 横幅并存）
    store.load.mockRejectedValue(new Error('打开失败'))
    let listCalls = 0
    store.list.mockImplementation(() => {
      listCalls += 1
      return firstCommitted && listCalls > 1
        ? [
            { id: 'p1', name: '雨夜' },
            { id: 'c1', name: '未命名短剧' },
          ]
        : [{ id: 'p1', name: '雨夜' }]
    })
    render(<App />)
    await screen.findByTestId('home')
    await act(async () => {
      const first = (homeProps.current.onCreateProject as () => Promise<void>)()
      const second = (
        homeProps.current.onCreateProject as () => Promise<void>
      )()
      await Promise.all([first, second])
    })
    // c1 由第一次认领；第二次确未创建——失败不得被吞（旧实现把 c1 误当
    // 第二次产出，横幅被抑制）
    expect(await screen.findByText(/create:未命名短剧:磁盘满/)).toBeTruthy()
    expect(store.create).toHaveBeenCalledTimes(2)
  })
})

describe('App ✦复制失败对账：部分提交（PR #199 评审）', () => {
  it('复制在其创建段提交后才失败：对账识别部分提交，不给盲重试', async () => {
    expectConsoleWarn()
    let dupCommitted = false
    store.duplicate.mockImplementation(() => {
      dupCommitted = true
      return Promise.reject(new Error('目录 fsync 失败'))
    })
    let listCalls = 0
    store.list.mockImplementation(() => {
      listCalls += 1
      return dupCommitted && listCalls > 1
        ? [
            { id: 'p1', name: '雨夜' },
            { id: 'copy-1', name: '雨夜 副本' },
          ]
        : [{ id: 'p1', name: '雨夜' }]
    })
    render(<App />)
    await screen.findByTestId('home')
    await act(async () => {
      await (
        homeProps.current.onDuplicateProject as (id: string) => Promise<void>
      )('p1')
    })
    // 部分（或全部）提交过：横幅给出诊断与空副本提示，但不提供盲重试
    expect(await screen.findByText(/duplicate:p1:/)).toBeTruthy()
    expect(screen.queryByTestId('retry-mutation')).toBeNull()
    expect(store.duplicate).toHaveBeenCalledTimes(1)
  })
})

describe('App ✦并发动作与旧错误序号（issue #132）', () => {
  it('并发动作：后发起者拥有终态，旧尝试的迟到失败不覆盖新尝试状态', async () => {
    expectConsoleWarn()
    let releaseRename: (() => void) | null = null
    store.delete.mockRejectedValue(new Error('del-fail'))
    store.load.mockResolvedValue(structuredClone(DOC))
    store.save.mockImplementationOnce(
      () =>
        new Promise((_res, rej) => {
          releaseRename = () => rej(new Error('rename-fail'))
        }),
    )
    render(<App />)
    await screen.findByTestId('home')
    await act(async () => {
      void (homeProps.current.onDeleteProject as (id: string) => Promise<void>)(
        'p1',
      )
      void (
        homeProps.current.onRenameProject as (
          id: string,
          name: string,
        ) => Promise<void>
      )('p1', '新名')
    })
    // delete 立即失败但其尝试序已被 rename 顶替：迟到失败被抑制
    expect(screen.queryByText(/del-fail/)).toBeNull()
    releaseRename!()
    await act(async () => {
      await Promise.resolve()
    })
    expect(await screen.findByText(/rename:新名:rename-fail/)).toBeTruthy()
  })
})

// 回归目标：不能按拒绝先后抢占另一失败尝试的已提交项目。
describe('App ✦并发失败的创建族归属', () => {
  it.each(['create', 'duplicate'] as const)(
    '先行创建无写入，后发 %s 已提交但也拒绝：不给后者盲重试',
    async (action) => {
      expectConsoleWarn()
      const projects = [{ id: 'p1', name: '雨夜' }]
      store.list.mockImplementation(async () => [...projects])
      const commitThenReject = async () => {
        await Promise.resolve()
        projects.push({ id: 'committed', name: '新项目' })
        throw new Error('应答丢失')
      }
      store.create.mockRejectedValueOnce(new Error('磁盘满'))
      if (action === 'create')
        store.create.mockImplementationOnce(commitThenReject)
      else store.duplicate.mockImplementationOnce(commitThenReject)
      render(<App />)
      await screen.findByText('共1项')
      await act(async () => {
        const first = (
          homeProps.current.onCreateProject as () => Promise<void>
        )()
        const second =
          action === 'create'
            ? (homeProps.current.onCreateProject as () => Promise<void>)()
            : (
                homeProps.current.onDuplicateProject as (
                  id: string,
                ) => Promise<void>
              )('p1')
        await Promise.all([first, second])
      })
      expect(screen.queryByTestId('retry-mutation')).toBeNull()
      expect(homeProps.current.projects).toHaveLength(2)
      if (action === 'create')
        expect(homeProps.current.mutationError).toBeNull()
      else expect(screen.getByRole('alert').textContent).toMatch(/副本/)
    },
  )
})

// 回归目标：列表读取拒绝不能被 [] 掩盖并开放非幂等重试。
describe('App ✦失败对账结果未知', () => {
  it.each(['create', 'duplicate'] as const)(
    '%s 拒绝后列表也失败：保留已知卡片与诊断，不提供重试',
    async (action) => {
      expectConsoleWarn()
      store[action].mockImplementationOnce(async () => {
        store.list.mockRejectedValue(new Error('目录暂不可读'))
        throw new Error('应答丢失')
      })
      render(<App />)
      await screen.findByText('共1项')
      await act(async () => {
        if (action === 'create') {
          await (homeProps.current.onCreateProject as () => Promise<void>)()
        } else {
          await (
            homeProps.current.onDuplicateProject as (
              id: string,
            ) => Promise<void>
          )('p1')
        }
      })
      expect(screen.queryByTestId('retry-mutation')).toBeNull()
      expect(screen.getByRole('alert').textContent).toMatch(/应答丢失/)
      expect(screen.getByRole('alert').textContent).toMatch(/无法确认/)
      expect(homeProps.current.loadError).toMatch(/目录暂不可读/)
      expect(homeProps.current.projects).toEqual([{ id: 'p1', name: '雨夜' }])
    },
  )
})

// 回归目标：确认没有副本残留的失败必须提供可完成复制的同参重试。
it('App ✦复制完全回滚后可重试，成功新增卡片并清除错误', async () => {
  expectConsoleWarn()
  const projects = [{ id: 'p1', name: '雨夜' }]
  store.list.mockImplementation(async () => [...projects])
  store.duplicate.mockRejectedValueOnce(new Error('拷贝失败且已清理'))
  store.duplicate.mockImplementationOnce(async () => {
    const copy = { id: 'copy-2', name: '雨夜 副本' }
    projects.push(copy)
    return copy
  })
  render(<App />)
  await screen.findByText('共1项')
  await act(async () => {
    await (
      homeProps.current.onDuplicateProject as (id: string) => Promise<void>
    )('p1')
  })
  expect(screen.getByRole('alert').textContent).toMatch(/duplicate:p1:拷贝失败/)
  fireEvent.click(screen.getByTestId('retry-mutation'))
  await screen.findByText('共2项')
  expect(screen.queryByRole('alert')).toBeNull()
  expect(store.duplicate).toHaveBeenNthCalledWith(2, 'p1')
})
