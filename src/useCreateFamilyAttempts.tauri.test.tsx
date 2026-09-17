// @vitest-environment happy-dom
/** 创建族队列与真实 Tauri 存储编排的集成回归；仅替换 IPC，保留复制清理与保存链。 */
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest'
import { cleanup, renderHook } from '@testing-library/react'
import { serializeProject } from './model/convert'
import type { ProjectDocument } from './model/document'

const handlers = new Map<string, (args: Record<string, unknown>) => unknown>()
vi.mock('@tauri-apps/api/core', () => ({
  invoke: async (command: string, args: Record<string, unknown> = {}) => {
    const handler = handlers.get(command)
    if (!handler) throw new Error(`未编排命令：${command}`)
    return handler(args)
  },
}))

let family: typeof import('./useCreateFamilyAttempts')
let store: typeof import('./projectStore').projectStore
const documents = new Map<string, ProjectDocument>()
let nextId = 0
const timestamp = '2026-09-18T00:00:00.000Z'

/** 建立完整 v1 文档，确保测试经过生产归一化与存储协议。 */
function seed(id: string, name = '雨夜') {
  const document = serializeProject(
    {
      name,
      createdAt: timestamp,
      nodes: [],
      edges: [],
      settings: { characters: [], locations: [] },
    },
    id,
  )
  documents.set(id, document)
  return metadata(document)
}

/** IPC 摘要从模拟持久文档读取，避免列表与真实写入副作用脱节。 */
function metadata(document: ProjectDocument) {
  return {
    id: document.project.id,
    name: document.project.name,
    updated_at: timestamp,
    scene_count: 0,
    ending_count: 0,
  }
}

beforeAll(async () => {
  Object.defineProperty(window, '__TAURI_INTERNALS__', {
    value: {},
    configurable: true,
  })
  ;({ projectStore: store } = await import('./projectStore'))
  family = await import('./useCreateFamilyAttempts')
})

beforeEach(() => {
  handlers.clear()
  documents.clear()
  seed('p1')
  handlers.set('list_projects', () => [...documents.values()].map(metadata))
  handlers.set('load_project', ({ id }) => {
    const document = documents.get(String(id))
    if (!document) throw new Error(`项目不存在：${String(id)}`)
    return structuredClone(document)
  })
  handlers.set('verify_project_assets', () => [])
  handlers.set('create_project', ({ name }) =>
    seed(`copy-${++nextId}`, String(name)),
  )
  handlers.set('copy_project_assets', () => undefined)
  handlers.set('save_project', ({ id, doc }) =>
    documents.set(String(id), doc as ProjectDocument),
  )
  handlers.set('delete_project', ({ id }) => documents.delete(String(id)))
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

/** 每个用例使用独立队列，入口读取走真实 Tauri 列表。 */
function coordinator() {
  return renderHook(() => family.useCreateFamilyAttempts(store.list)).result
    .current
}

/** 经生产入口运行创建或完整复制，不 mock 门面方法。 */
function run(
  attempts: ReturnType<typeof coordinator>,
  action: 'create' | 'duplicate',
) {
  return action === 'create'
    ? family.createWithReconcile(attempts, '新项目')
    : family.duplicateWithReconcile(attempts, 'p1')
}

/** 暂挂创建 IPC 应答，允许队列外的删除/刷新先落定，再交付创建失败。 */
function pauseCreate() {
  let entered!: () => void
  let reject!: (reason: Error) => void
  const started = new Promise<void>((resolve) => (entered = resolve))
  const pending = new Promise<never>((_resolve, fail) => (reject = fail))
  handlers.set('create_project', () => {
    entered()
    return pending
  })
  return { started, fail: () => reject(new Error('创建命令拒绝')) }
}

// 回归目标：把列表播种误认成创建族产出会吞掉错误或错误禁止安全重试。
it.each([
  ['create', false],
  ['duplicate', false],
  ['create', true],
  ['duplicate', true],
] as const)(
  '%s 无写入失败，最后项目被删除（普通刷新先播种=%s）：示例不算本次产出',
  async (action, refreshFirst) => {
    const paused = pauseCreate()
    const attempts = coordinator()
    const result = run(attempts, action)
    await paused.started
    await store.delete('p1')
    if (refreshFirst) await store.list()
    paused.fail()
    expect(await result).toMatchObject({
      kind: 'rejected',
      commitState: 'absent',
      err: new Error('创建命令拒绝'),
    })
    expect((await store.list()).map((project) => project.id).sort()).toEqual([
      'sample-du-shi-qi-yuan',
      'sample-wu-ye-chu-zu-che',
    ])
    handlers.set('create_project', ({ name }) => seed('retried', String(name)))
    // 复制源已被删除，恢复该源后同参重试；创建则直接重试。
    if (action === 'duplicate') seed('p1')
    expect(await run(attempts, action)).toEqual({
      kind: 'created',
      id: 'retried',
    })
    expect((await store.load('retried')).name).toBe(
      action === 'create' ? '新项目' : '雨夜 副本',
    )
  },
)

// 排除规则须精确匹配示例身份；同名或同前缀的其他项目仍是实际产出。
it.each(['p-created', 'sample-custom'])(
  '播种之外还提交了 %s：即使与示例同名也不能开放盲重试',
  async (id) => {
    const paused = pauseCreate()
    const result = family.createWithReconcile(coordinator(), '午夜出租车')
    await paused.started
    await store.delete('p1')
    await store.list()
    seed(id, '午夜出租车')
    paused.fail()
    expect(await result).toMatchObject({
      kind: 'rejected',
      commitState: 'present',
    })
    expect((await store.list()).map((project) => project.id)).toContain(id)
    expect((await store.load(id)).name).toBe('午夜出租车')
  },
)

// 回归目标：重列失败必须保留未知状态，即使已经知道列表写入了示例。
it('对账播种后重列失败保留未知；读取恢复后队列可继续', async () => {
  const list = handlers.get('list_projects')!
  const paused = pauseCreate()
  const attempts = coordinator()
  const result = run(attempts, 'create')
  await paused.started
  await store.delete('p1')
  handlers.set('list_projects', (args) => {
    if (documents.has('sample-wu-ye-chu-zu-che')) {
      throw new Error('播种后重列失败')
    }
    return list(args)
  })
  paused.fail()
  expect(await result).toMatchObject({
    kind: 'rejected',
    commitState: 'unknown',
    err: new Error('创建命令拒绝'),
  })
  handlers.set('list_projects', list)
  expect((await store.list()).map((project) => project.id).sort()).toEqual([
    'sample-du-shi-qi-yuan',
    'sample-wu-ye-chu-zu-che',
  ])
  handlers.set('create_project', ({ name }) => seed('recovered', String(name)))
  expect(await run(attempts, 'create')).toEqual({
    kind: 'created',
    id: 'recovered',
  })
  expect((await store.load('recovered')).name).toBe('新项目')
})

// 回归目标：失败先后与产出归属不能混淆，create/duplicate 必须共用完整尝试窗口。
describe('创建族双拒绝的产出归属', () => {
  it.each([
    ['create', 'create'],
    ['create', 'duplicate'],
    ['duplicate', 'create'],
    ['duplicate', 'duplicate'],
  ] as const)(
    '%s → %s：先失败者无写入，后失败者提交',
    async (first, second) => {
      let calls = 0
      handlers.set('create_project', async ({ name }) => {
        if (++calls === 1) throw new Error('无写入')
        await Promise.resolve()
        seed('committed', String(name))
        throw new Error('提交后拒绝')
      })
      const attempts = coordinator()
      const results = await Promise.all([
        run(attempts, first),
        run(attempts, second),
      ])
      expect(results).toMatchObject([
        { kind: 'rejected', commitState: 'absent' },
        { kind: 'rejected', commitState: 'present' },
      ])
      expect((await store.list()).map((project) => project.id)).toEqual([
        'p1',
        'committed',
      ])
    },
  )
})

// 回归目标：后续尝试必须从存储重读基线，不能复用 React 尚未更新的快照。
it('前次已提交但拒绝，后次无写入：后次允许重试，不认领前次项目', async () => {
  let calls = 0
  handlers.set('create_project', ({ name }) => {
    if (++calls === 1) seed('first', String(name))
    throw new Error('创建拒绝')
  })
  const attempts = coordinator()
  const results = await Promise.all([
    run(attempts, 'duplicate'),
    run(attempts, 'create'),
  ])
  expect(results).toMatchObject([
    { kind: 'rejected', commitState: 'present' },
    { kind: 'rejected', commitState: 'absent' },
  ])
  expect(documents.size).toBe(2)
})

// 回归目标：对账读取拒绝不能变成安全重试，失败也不能毒化后续队列。
it('提交后对账失败返回未知；恢复读取后的请求不认领旧项目', async () => {
  const list = handlers.get('list_projects')!
  handlers.set('create_project', () => {
    seed('uncertain')
    handlers.set('list_projects', () => {
      throw new Error('列表失败')
    })
    throw new Error('应答丢失')
  })
  const attempts = coordinator()
  expect(await run(attempts, 'create')).toMatchObject({
    kind: 'rejected',
    commitState: 'unknown',
    err: new Error('应答丢失'),
  })
  handlers.set('list_projects', list)
  handlers.set('create_project', () => {
    throw new Error('无写入')
  })
  expect(await run(attempts, 'duplicate')).toMatchObject({
    kind: 'rejected',
    commitState: 'absent',
  })
  expect((await store.list()).map((project) => project.id)).toEqual([
    'p1',
    'uncertain',
  ])
})

// 回归目标：没有可信基线时不启动非幂等写入；恢复后队列仍能执行。
it('基线读取拒绝时无写入且可重试，恢复后创建成功', async () => {
  const list = handlers.get('list_projects')!
  handlers.set('list_projects', () => {
    throw new Error('列表失败')
  })
  const attempts = coordinator()
  expect(await run(attempts, 'create')).toMatchObject({
    kind: 'rejected',
    commitState: 'absent',
    err: new Error('列表失败'),
  })
  expect(documents.size).toBe(1)
  handlers.set('list_projects', list)
  expect(await run(attempts, 'create')).toMatchObject({ kind: 'created' })
  expect((await store.list()).map((project) => project.name)).toEqual([
    '雨夜',
    '新项目',
  ])
})

// 回归目标：复制清理是否成功决定重试安全，不能一律禁止或开放重试。
describe('复制失败与实际回滚结果', () => {
  it.each([true, false])(
    '资产拷贝失败，清理成功=%s',
    async (cleanupSucceeds) => {
      handlers.set('copy_project_assets', () => {
        throw new Error('资产拷贝失败')
      })
      if (!cleanupSucceeds) {
        handlers.set('delete_project', () => {
          throw new Error('清理失败')
        })
      }
      const attempts = coordinator()
      expect(await run(attempts, 'duplicate')).toMatchObject({
        kind: 'rejected',
        commitState: cleanupSucceeds ? 'absent' : 'present',
      })
      expect((await store.list()).map((project) => project.name)).toEqual(
        cleanupSucceeds ? ['雨夜'] : ['雨夜', '雨夜 副本'],
      )
      if (cleanupSucceeds) {
        handlers.set('copy_project_assets', () => undefined)
        expect(await run(attempts, 'duplicate')).toMatchObject({
          kind: 'created',
        })
        expect((await store.list()).map((project) => project.name)).toEqual([
          '雨夜',
          '雨夜 副本',
        ])
      }
    },
  )

  it('源文档读取失败没有副本残留，可重试', async () => {
    handlers.set('load_project', () => {
      throw new Error('源项目不可读')
    })
    expect(await run(coordinator(), 'duplicate')).toMatchObject({
      kind: 'rejected',
      commitState: 'absent',
    })
    expect((await store.list()).map((project) => project.id)).toEqual(['p1'])
  })
})
