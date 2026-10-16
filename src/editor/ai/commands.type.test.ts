/**
 * [issue #553](https://github.com/hailingu/PlotWeave/issues/553) 执行命令
 * 载荷形态的类型层回归：ValidatedCommand 是显式判别联合——校验后的
 * 载荷（nodeType/edgeKind/data/fields）进入类型系统，非法命令形态在
 * 编译期拒绝，模拟引擎（batchSim）不得再以 as 自行收窄。误配由 tsc
 * 把关（@ts-expect-error 与 satisfies），不设行为断言（先例：
 * serialize.type.test.ts、RightPanel.aiProps.type.test.ts）。
 */
import { describe, expect, expectTypeOf, it } from 'vitest'
import type { EdgeKind } from '../graphRules'
import type { NodeDataPatch } from '../nodes/patch'
import type { AiNodeFieldType } from './nodeFields'
import type {
  ValidatedCommand,
  ValidatedDocumentFields,
  ValidatedEntityFields,
} from './commands'

describe('ValidatedCommand 判别联合（issue #553）', () => {
  it('op 域锁定：八个执行命令成员，新增命令须显式扩展契约与模拟分发', () => {
    expectTypeOf<ValidatedCommand['op']>().toEqualTypeOf<
      | 'create_node'
      | 'update_node'
      | 'delete_node'
      | 'connect_edge'
      | 'disconnect_edge'
      | 'upsert_character'
      | 'upsert_location'
      | 'upsert_document'
    >()
  })

  it('create 的 nodeType 收窄为协议成员、data 必在（归一化恒产出记录）', () => {
    expectTypeOf<
      Extract<ValidatedCommand, { op: 'create_node' }>['nodeType']
    >().toEqualTypeOf<AiNodeFieldType>()
    const create = {
      op: 'create_node',
      nodeType: 'scene',
      ref: 'ns',
      data: { name: '新场' },
    } satisfies Extract<ValidatedCommand, { op: 'create_node' }>
    expect(create.data).toEqual({ name: '新场' })
  })

  it('connect 的 edgeKind 收窄为三成员字面量（校验补全缺省 sequence）', () => {
    expectTypeOf<
      Extract<ValidatedCommand, { op: 'connect_edge' }>['edgeKind']
    >().toEqualTypeOf<EdgeKind>()
    const connect = {
      op: 'connect_edge',
      sourceId: 's1',
      targetId: 's2',
      edgeKind: 'sequence',
    } satisfies Extract<ValidatedCommand, { op: 'connect_edge' }>
    expect(connect.edgeKind).toBe('sequence')
  })

  it('upsert 的 entityId/ref 为字符串、fields 绑定各自已校验形态', () => {
    expectTypeOf<
      Extract<ValidatedCommand, { op: 'upsert_character' }>['fields']
    >().toEqualTypeOf<ValidatedEntityFields>()
    expectTypeOf<
      Extract<ValidatedCommand, { op: 'upsert_document' }>['fields']
    >().toEqualTypeOf<ValidatedDocumentFields>()
    const upsert = {
      op: 'upsert_character',
      ref: 'hero',
      fields: { name: '林一', bio: '侦探' },
    } satisfies ValidatedCommand
    expect(upsert.fields.name).toBe('林一')
  })

  it('非法形态编译期拒绝：协议外类型 / 缺 data / 非法连线语义 / 非字符串实体值', () => {
    // 负向断言采用 serialize.type.test.ts 的赋值行先例：编译错误落在
    // expect-error 指令紧邻的下一行，Prettier 重排对象字面量不改变判定行
    const create: ValidatedCommand = {
      op: 'create_node',
      nodeType: 'scene',
      data: {},
    }
    // @ts-expect-error —— image 是生成侧媒体节点（§13 首版 AI 只读），不在写通道
    create.nodeType = 'image'
    // @ts-expect-error —— 校验后的 nodeType 是协议成员字面量（原型键同理），不再是任意 string
    create.nodeType = 'toString'
    // @ts-expect-error —— 校验后 data 必在（foldCreate 恒产出归一化记录）
    create.data = undefined
    const connect: ValidatedCommand = {
      op: 'connect_edge',
      sourceId: 's1',
      targetId: 's2',
      edgeKind: 'sequence',
    }
    // @ts-expect-error —— 校验后 edgeKind 必为 sequence/branch/attach 三成员
    connect.edgeKind = 'weird'
    const upsert: ValidatedCommand = {
      op: 'upsert_character',
      fields: { name: '林一' },
    }
    // @ts-expect-error —— 实体 fields 为白名单键的全字符串记录
    upsert.fields = { bio: 3 }
    // 断言主体在编译期（上方 expect-error 指令）；运行时断言按类型测试
    // 先例（AiThread.commitIdentity.type.test.ts）消费变量引用
    expect(create).toBeTruthy()
    expect(connect).toBeTruthy()
    expect(upsert).toBeTruthy()
  })

  it('update_node 的补丁仍为判别化形态（issue 16 契约保持）', () => {
    expectTypeOf<
      Extract<ValidatedCommand, { op: 'update_node' }>['patch']
    >().toEqualTypeOf<NodeDataPatch>()
    const update: ValidatedCommand = {
      op: 'update_node',
      nodeId: 'n1',
      patch: { nodeType: 'scene', patch: { synopsis: '旧' } },
    }
    // @ts-expect-error —— 缺 nodeType 判别字段的宽补丁不得进入执行/撤销路径
    update.patch = { synopsis: 'x' }
    expect(update).toBeDefined()
  })
})
