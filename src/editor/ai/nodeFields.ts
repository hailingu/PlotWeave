/**
 * AI 节点字段协议的单一真相（issue 41）：工具参数描述、系统提示词与
 * validateAiBatch 的字段白名单都从这里生成，三方不再各自维护、静默漂移
 * ——模型侧协议与校验器口径不一致正是「AI 创建节奏卡整批失败」的直接
 * 缺口。字段集合与 nodes/types.ts 的 *NodeData 一一对应（⚙️ 设置面板
 * 可编辑的字段域）；值形状细节（正整数编号、非空白引用、列表成员结构）
 * 仍由 commands.ts 的入站信任边界校验执行，此处只承载「有哪些字段、
 * 什么类型、什么含义」的协议描述。新增可写字段只改此表。
 */

/** 单个 AI 可写字段的协议描述。 */
export interface AiFieldSpec {
  /** 字段键（= *NodeData 属性名，校验白名单的直接来源）。 */
  key: string
  /** 值类型（JSON 词汇）。 */
  type: 'string' | 'integer' | 'boolean' | 'array'
  /** 人读一句话说明（进系统提示与工具描述）。 */
  desc: string
}

/** 各 AI 可写节点类型的字段协议表。episodeNo（§3.5 分集）：编剧侧四类
 * 可写；分镜卡随宿主场景，不可单独分集。图片节点（§13 首版 AI 只读）
 * 不在此表——白名单缺失类型一律整批拒绝。 */
export const AI_NODE_FIELDS: Record<string, readonly AiFieldSpec[]> = {
  scene: [
    { key: 'name', type: 'string', desc: '场景名' },
    { key: 'sceneNo', type: 'integer', desc: '场号（正整数）' },
    { key: 'interior', type: 'boolean', desc: '内景 true / 外景 false' },
    { key: 'locationId', type: 'string', desc: '地点实体 id（设定集）' },
    { key: 'time', type: 'string', desc: '时间（如 🌙 夜）' },
    { key: 'weather', type: 'string', desc: '天气（可省）' },
    { key: 'synopsis', type: 'string', desc: '梗概' },
    { key: 'characterIds', type: 'array', desc: '在场角色实体 id 数组（设定集）' },
    { key: 'episodeNo', type: 'integer', desc: '集归属（正整数）' },
  ],
  dialogue: [
    { key: 'name', type: 'string', desc: '对白名' },
    { key: 'lines', type: 'array', desc: '台词行对象数组（text 必填；kind ∈ line/action；speaker 仅 line 行，为角色实体 id）' },
    { key: 'episodeNo', type: 'integer', desc: '集归属（正整数）' },
  ],
  beat: [
    { key: 'name', type: 'string', desc: '节拍名' },
    { key: 'tone', type: 'string', desc: '情绪基调' },
    { key: 'episodeNo', type: 'integer', desc: '集归属（正整数）' },
  ],
  branch: [
    { key: 'prompt', type: 'string', desc: '分岔问句' },
    { key: 'options', type: 'array', desc: '选项文案数组（字符串或 {label} 对象）' },
    { key: 'episodeNo', type: 'integer', desc: '集归属（正整数）' },
  ],
  shot: [
    { key: 'shotNo', type: 'integer', desc: '镜号（正整数）' },
    { key: 'size', type: 'string', desc: '景别（特写/中景/全景…）' },
    { key: 'picture', type: 'string', desc: '画面描述' },
    { key: 'prompt', type: 'string', desc: '镜头 Prompt（AI 视频模型输入）' },
    { key: 'refs', type: 'array', desc: '引用位对象数组（kind ∈ character/location/audio + assetId 引用或 label 自由文案）' },
  ],
}

/** 校验白名单视图：类型 → 合法字段键（checkFieldKeys 消费）。 */
export const AI_FIELD_KEYS: Record<string, readonly string[]> = Object.fromEntries(
  Object.entries(AI_NODE_FIELDS).map(([type, fields]) => [type, fields.map((f) => f.key)]),
)

/** 生成「类型: 字段(类型) 说明」行式协议文本：系统提示与工具描述共用
 * 同一函数输出，保证两处逐字一致、随协议表同步演进。 */
export function nodeFieldTableText(): string {
  return Object.entries(AI_NODE_FIELDS)
    .map(([type, fields]) => {
      const row = fields.map((f) => `${f.key}(${f.type}) ${f.desc}`).join('；')
      return `${type}: ${row}`
    })
    .join('\n')
}
