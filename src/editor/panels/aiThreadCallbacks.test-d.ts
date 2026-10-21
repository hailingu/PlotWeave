/** #664：抽取前后必须保持领域可选成员与显式 undefined 透传的区别。 */
import type { ComponentProps } from 'react'
import type { AiThread } from './AiThread'
import type { RightPanelAiProps } from './RightPanel'
import type { UseAiTurnOpts } from './aiThreadTurn'
import type { readToolOf } from './aiThreadModel'

type Accepts<From, To> = [From] extends [To] ? true : false
type Yes<T extends true> = T
type No<T extends false> = T
type RightRead = Pick<RightPanelAiProps, 'onReadNode'>
type ThreadRead = Pick<ComponentProps<typeof AiThread>, 'onReadNode'>
type TurnRead = Pick<UseAiTurnOpts, 'onReadNode'>

/** 仅类型检查，无运行时断言；省略、合法清空和位置参数最小数量各自固定。 */
export type CallbackCompatibility = [
  Yes<Accepts<Record<string, never>, RightRead>>,
  No<Accepts<{ onReadNode: undefined }, RightRead>>,
  Yes<Accepts<{ onReadNode: undefined }, ThreadRead>>,
  Yes<Accepts<{ onReadNode: undefined }, TurnRead>>,
  Yes<Accepts<{ onReadNode: (id: string) => string | null }, RightRead>>,
  No<Accepts<{ onReadNode: (id: number) => string | null }, RightRead>>,
  No<Accepts<[undefined], Parameters<typeof readToolOf>>>,
  Yes<Accepts<[undefined, undefined], Parameters<typeof readToolOf>>>,
  Yes<
    Accepts<
      [undefined, undefined, undefined, undefined, undefined],
      Parameters<typeof readToolOf>
    >
  >,
]
