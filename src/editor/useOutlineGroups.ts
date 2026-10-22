/** Shared Web/native outline cache retains content and the exact domain x/id fallback order. */
import { useMemo, useState } from 'react'
import type { Edge } from '@xyflow/react'
import { buildOutlineGroups, type OutlineGroup } from './outline'
import type { CanvasNode } from './nodes/types'

const EMPTY_GROUPS: OutlineGroup[] = []

/** 大纲派生的「内容 + 剧情流回退序」键控缓存（issue #157）：行序按剧情流
 * 分区线性序（storylineGroups，issue #340），位置只影响无前驱约束节点
 * 的回退交织。缓存键用与 storylineGroups 完全同款的 x/id 比较器（issue
 * #340 评审三轮）：键序不变则行序必然不变，键序变化即失效——旧「仅按
 * x 稳定排序」的键在两节点落到相等 x 时读数组序、不随 id 决胜切换，面板
 * 会滞留旧序而导出已是新序。PR #194 当年移除次级键的理由（相等帧的序
 * 先于真实行序变化）已随 #340 的确定性回退序失效：相等帧的 id 键序就是
 * 当帧真实行序，不存在超前错位。缓存直接持有 id 数组并逐元素比较（评审
 * 4027732274）：id 契约仅要求非空唯一，join('|') 等分隔符编码对 'a' 与
 * 'a|a' 这类合法脏档 id 有歧义（两种顺序同串）。连线重排不经过此缓存
 * ——edges 变化直接触发 useMemo 重算。 */
export function useOutlineGroups(
  nodes: CanvasNode[],
  contentNodes: CanvasNode[],
  edges: Edge[],
  episodeTitles: Record<number, string>,
  enabled = true,
): OutlineGroup[] {
  const order = useMemo(
    () =>
      enabled
        ? nodes
            .slice()
            .sort(
              (a, b) => a.position.x - b.position.x || (a.id < b.id ? -1 : 1),
            )
            .map((n) => n.id)
        : [],
    [nodes, enabled],
  )
  // 条件式派生 state 随 React 的提交/丢弃边界回滚，不在渲染中改写共享 ref。
  const [cache, setCache] = useState(() => ({
    content: contentNodes,
    order,
    source: nodes,
  }))
  const sameOrder =
    cache.order.length === order.length &&
    cache.order.every((id, i) => id === order[i])
  const stale = cache.content !== contentNodes || !sameOrder
  if (stale) setCache({ content: contentNodes, order, source: nodes })
  const source = stale ? nodes : cache.source
  return useMemo(
    () =>
      enabled ? buildOutlineGroups(source, edges, episodeTitles) : EMPTY_GROUPS,
    [source, edges, episodeTitles, enabled],
  )
}
