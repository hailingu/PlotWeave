/**
 * #75：随系统提示发送可执行的完整批次示例，补足仅有字段表时缺失的
 * 嵌套行、实体引用和顺序插入语义；示例不是当前画布，也不由应用自动执行。
 */

const sceneInsertion = { commands: [
  { op: 'disconnect_edge', sourceId: 'A', targetId: 'B', reason: '将新场景插入原剧情流' },
  { op: 'create_node', nodeType: 'scene', ref: 'new_scene', data: {
    name: '吞并计划', episodeNo: 1, interior: false, time: '午后',
    synopsis: '对手亮出连锁便利店吞并计划，承接立势节拍。',
  } },
  { op: 'connect_edge', sourceId: 'A', targetId: 'new_scene', edgeKind: 'sequence' },
  { op: 'connect_edge', sourceId: 'new_scene', targetId: 'B', edgeKind: 'sequence' },
] }

const dialogueInsertion = { commands: [
  { op: 'upsert_character', ref: 'manager', fields: { name: '连锁店长', bio: '负责收购谈判。' } },
  { op: 'disconnect_edge', sourceId: 'C', targetId: 'B', reason: '将对白插入场景后的剧情流' },
  { op: 'create_node', nodeType: 'dialogue', ref: 'new_dialogue', data: {
    name: '收购交锋', episodeNo: 1, lines: [
      { kind: 'line', speaker: 'manager', side: 'left', vo: false, text: '这份收购方案，你可以考虑一下。' },
      { kind: 'action', text: '店长把合同推到桌面中央。' },
    ],
  } },
  { op: 'connect_edge', sourceId: 'C', targetId: 'new_dialogue', edgeKind: 'sequence' },
  { op: 'connect_edge', sourceId: 'new_dialogue', targetId: 'B', edgeKind: 'sequence' },
] }

/** 工具和围栏通道共用同一批次形状；围栏展示的 JSON 可直接用作 batch 参数。 */
function example(title: string, batch: object): string {
  return `${title}\n\`\`\`json\n${JSON.stringify(batch, null, 2)}\n\`\`\``
}

/** 初次请求与每次纠正都能参照的完整创建协议；不改变通用图的多出口能力。 */
export const CREATION_GUIDE = [
  '创建与插入指南：以下是输出形状示例，不是当前画布数据或待执行指令。' +
    'A、B、C 均为占位 id，必须换成当前快照／get_node 中确认的真实 id；内容与集号按用户要求调整。' +
    '先读取目标详情、连线和所需设定；有同名角色时复用确认的实体 id，有歧义时澄清。' +
    '不要把角色名、对象、null 放入 speaker；无说话人则省略，新角色先 upsert 并用 ref 引用。',
  '用户要求「在 A 后创建／插入」且 A 只有一个明确的 sequence 后继 B 时，默认是顺序插入：' +
    '同批 disconnect A→B、create C、connect A→C、connect C→B，不保留绕过 C 的旧直连。' +
    '没有后继时仅创建并连接 A→C；有多个后继或分支选项且用户未指定路径时先澄清，不能猜删。' +
    '只有用户明确要求额外路径时才保留原路径；不要删除无关连线。' +
    '对白走 sequence；只有场景下挂分镜使用 attach。断开旧边和新建连线都必须进入同一个待确认预览。',
  '下面每个 JSON 对象都是一次 batch 的完整参数。支持工具时实际调用 batch；' +
    '不支持工具时输出同形状的完整 JSON 围栏。不要仅描述将调用工具或将创建预览。' +
    '纠正时重新输出整批，不只输出修正的一条；缺少必要信息时明确提问。' +
    '省略的可选字段由应用提供默认值，节点／行／选项的持久 id 由应用分配。',
  example('示例一：已确认节拍 A 唯一顺序连接节拍 B，在两者之间插入场景。', sceneInsertion),
  example('示例二：已确认场03（C）唯一顺序连接 B，设定集中没有「连锁店长」。在场03后插入带该新角色的对白。', dialogueInsertion),
].join('\n\n')
