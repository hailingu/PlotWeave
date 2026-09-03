/**
 * 示例画布（种子项目数据）：一个两幕短剧结构，演示生产管线的完整上下游关系——
 * 第一幕：节奏卡「雨夜对峙」→ 索引卡「雨夜天台」（挂两张分镜卡）
 * → 对白「真相逼近」→ 分支「是否发现真相」；
 * 支线：坦白 → 索引卡「天台摊牌」→ 对白「十年前的雨」；
 *       隐瞒 → 索引卡「独自离开」；
 * 第二幕：节奏卡「身份揭晓」→ 两线汇合于索引卡「旧公寓」（挂一张分镜卡）
 * → 分支「是否原谅」→ 双结局「天台黎明」/「车站告别」。
 * 持久化落地后作为首次启动的种子项目写入；真实创作项目由用户新建。
 */
import type { Edge } from '@xyflow/react'
import { SCENE_SHOT_HANDLE } from './nodes/SceneNode'
import { branchOptionHandle } from './graphRules'
import { LIN_WAN_ID, CHEN_MO_ID, LOC_ROOFTOP_ID, LOC_APARTMENT_ID, LOC_STATION_ID } from './sampleData'
import type { CanvasNode } from './nodes/types'

export const SAMPLE_NODES: CanvasNode[] = [
  {
    id: 'beat-1',
    type: 'beat',
    position: { x: 0, y: 80 },
    data: { name: '雨夜对峙', tone: '压抑渐强' },
  },
  {
    id: 'scene-3',
    type: 'scene',
    position: { x: 320, y: 40 },
    selected: true,
    data: {
      name: '雨夜天台',
      sceneNo: 3,
      interior: false,
      locationId: LOC_ROOFTOP_ID,
      time: '🌙 夜',
      weather: '🌧 雨',
      synopsis: '林晚翻出父亲死亡当夜的档案，陈默突然出现，要她立刻离开天台。',
      characterIds: [LIN_WAN_ID, CHEN_MO_ID],
    },
  },
  {
    id: 'shot-1',
    type: 'shot',
    position: { x: 175, y: 320 },
    data: {
      shotNo: 1,
      size: '远景',
      picture: '雨夜城市天台全景，林晚撑伞站在栏杆边，陈默从阴影中走出。',
      prompt: 'rainy rooftop at night, cinematic wide shot, neon reflections, two figures confronting',
      refs: [
        { id: 'ref-sg-1', kind: 'character', label: '林晚垫图' },
        { id: 'ref-sg-2', kind: 'location', label: '天台底图' },
        { id: 'ref-sg-3', kind: 'audio', label: '雨声' },
      ],
    },
  },
  {
    id: 'shot-2',
    type: 'shot',
    position: { x: 505, y: 320 },
    data: {
      shotNo: 2,
      size: '特写',
      picture: '档案袋里的旧照片特写，指尖颤抖，雨水滴落在照片上。',
      prompt: 'extreme close-up of trembling hands holding an old photo, raindrops, shallow depth of field',
      refs: [
        { id: 'ref-sg-4', kind: 'character', label: '林晚垫图' },
        { id: 'ref-sg-5', kind: 'audio', label: '雨声' },
      ],
    },
  },
  {
    id: 'dialogue-1',
    type: 'dialogue',
    position: { x: 770, y: 60 },
    data: {
      name: '真相逼近',
      lines: [
        { id: 'line-sg-1', kind: 'line', speaker: LIN_WAN_ID, side: 'left', text: '你早就知道，对吗？' },
        { id: 'line-sg-2', kind: 'action', text: '陈默沉默，雨声渐大' },
        { id: 'line-sg-3', kind: 'line', speaker: CHEN_MO_ID, side: 'right', text: '……我是为了保护你。' },
      ],
    },
  },
  {
    id: 'branch-1',
    type: 'branch',
    position: { x: 1230, y: 60 },
    data: { prompt: '林晚是否发现真相？', options: [
        { id: 'opt-sg-1', label: '坦白' },
        { id: 'opt-sg-2', label: '隐瞒' },
      ] },
  },
  {
    id: 'scene-4',
    type: 'scene',
    position: { x: 1630, y: -60 },
    data: {
      name: '天台摊牌',
      sceneNo: 4,
      interior: false,
      locationId: LOC_ROOFTOP_ID,
      time: '🌙 夜',
      weather: '🌧 雨',
      synopsis: '陈默坦白当年真相，林晚在雨中久久无言。',
      characterIds: [LIN_WAN_ID, CHEN_MO_ID],
    },
  },
  {
    id: 'dialogue-2',
    type: 'dialogue',
    position: { x: 2080, y: -60 },
    data: {
      name: '十年前的雨',
      lines: [
        { id: 'line-sg-4', kind: 'line', speaker: CHEN_MO_ID, side: 'left', text: '那晚，我也在旧公寓。' },
        { id: 'line-sg-5', kind: 'line', speaker: LIN_WAN_ID, side: 'right', text: '为什么十年都不告诉我？' },
      ],
    },
  },
  {
    id: 'scene-5',
    type: 'scene',
    position: { x: 1630, y: 240 },
    data: {
      name: '独自离开',
      sceneNo: 5,
      interior: false,
      locationId: LOC_ROOFTOP_ID,
      time: '🌙 夜',
      weather: '🌧 雨',
      synopsis: '陈默选择隐瞒，林晚转身离开，雨幕吞没背影。',
      characterIds: [LIN_WAN_ID],
    },
  },
  {
    id: 'beat-2',
    type: 'beat',
    position: { x: 2080, y: 260 },
    data: { name: '身份揭晓', tone: '爆发' },
  },
  {
    id: 'scene-6',
    type: 'scene',
    position: { x: 2530, y: 80 },
    data: {
      name: '旧公寓',
      sceneNo: 6,
      interior: true,
      locationId: LOC_APARTMENT_ID,
      time: '🌙 夜',
      synopsis: '林晚在旧公寓找到父亲留下的第二张照片，两条支线的真相在此汇合。',
      characterIds: [LIN_WAN_ID],
    },
  },
  {
    id: 'shot-3',
    type: 'shot',
    position: { x: 2550, y: 340 },
    data: {
      shotNo: 3,
      size: '中景',
      picture: '旧公寓昏黄灯光下，林晚蹲在纸箱前，手里的照片微微发抖。',
      prompt: 'dim old apartment, medium shot, woman crouching by cardboard boxes, warm tungsten light',
      refs: [
        { id: 'ref-sg-6', kind: 'character', label: '林晚垫图' },
        { id: 'ref-sg-7', kind: 'location', label: '旧公寓底图' },
      ],
    },
  },
  {
    id: 'branch-2',
    type: 'branch',
    position: { x: 2980, y: 80 },
    data: { prompt: '林晚是否原谅陈默？', options: [
        { id: 'opt-sg-3', label: '原谅' },
        { id: 'opt-sg-4', label: '不原谅' },
      ] },
  },
  {
    id: 'scene-7',
    type: 'scene',
    position: { x: 3430, y: -20 },
    data: {
      name: '天台黎明',
      sceneNo: 7,
      interior: false,
      locationId: LOC_ROOFTOP_ID,
      time: '🌅 晨',
      synopsis: '雨停了，两人并肩坐在天台边缘，看城市醒来。',
      characterIds: [LIN_WAN_ID, CHEN_MO_ID],
    },
  },
  {
    id: 'scene-8',
    type: 'scene',
    position: { x: 3430, y: 260 },
    data: {
      name: '车站告别',
      sceneNo: 8,
      interior: false,
      locationId: LOC_STATION_ID,
      time: '🌅 晨',
      synopsis: '林晚独自踏上列车，把那张照片留在了站台长椅上。',
      characterIds: [LIN_WAN_ID],
    },
  },
]

/** 示例连线：sequence 中性灰走横向剧情流；attach 细虚线从索引卡底部垂直下挂分镜卡；
 * branch 从分支选项端口出发、带选项胶囊。 */
export const SAMPLE_EDGES: Edge[] = [
  // 第一幕：节奏卡 → 索引卡 → 对白 → 分支
  { id: 'e-beat1-scene3', source: 'beat-1', target: 'scene-3', className: 'pw-edge-sequence' },
  {
    id: 'e-scene3-shot1',
    source: 'scene-3',
    sourceHandle: SCENE_SHOT_HANDLE,
    target: 'shot-1',
    className: 'pw-edge-attach',
  },
  {
    id: 'e-scene3-shot2',
    source: 'scene-3',
    sourceHandle: SCENE_SHOT_HANDLE,
    target: 'shot-2',
    className: 'pw-edge-attach',
  },
  { id: 'e-scene3-dialogue1', source: 'scene-3', target: 'dialogue-1', className: 'pw-edge-sequence' },
  { id: 'e-dialogue1-branch1', source: 'dialogue-1', target: 'branch-1', className: 'pw-edge-sequence' },
  // 支线：坦白 / 隐瞒（端口绑稳定选项 id）
  {
    id: 'e-branch1-confess',
    source: 'branch-1',
    sourceHandle: branchOptionHandle('opt-sg-1'),
    target: 'scene-4',
    type: 'branch',
    data: { optionLabel: '坦白' },
  },
  {
    id: 'e-branch1-hide',
    source: 'branch-1',
    sourceHandle: branchOptionHandle('opt-sg-2'),
    target: 'scene-5',
    type: 'branch',
    data: { optionLabel: '隐瞒' },
  },
  { id: 'e-scene4-dialogue2', source: 'scene-4', target: 'dialogue-2', className: 'pw-edge-sequence' },
  // 第二幕：节奏卡 → 两线汇合于旧公寓
  { id: 'e-dialogue2-scene6', source: 'dialogue-2', target: 'scene-6', className: 'pw-edge-sequence' },
  { id: 'e-scene5-scene6', source: 'scene-5', target: 'scene-6', className: 'pw-edge-sequence' },
  { id: 'e-beat2-scene6', source: 'beat-2', target: 'scene-6', className: 'pw-edge-sequence' },
  {
    id: 'e-scene6-shot3',
    source: 'scene-6',
    sourceHandle: SCENE_SHOT_HANDLE,
    target: 'shot-3',
    className: 'pw-edge-attach',
  },
  // 结局分支：双结局
  { id: 'e-scene6-branch2', source: 'scene-6', target: 'branch-2', className: 'pw-edge-sequence' },
  {
    id: 'e-branch2-forgive',
    source: 'branch-2',
    sourceHandle: branchOptionHandle('opt-sg-3'),
    target: 'scene-7',
    type: 'branch',
    data: { optionLabel: '原谅' },
  },
  {
    id: 'e-branch2-leave',
    source: 'branch-2',
    sourceHandle: branchOptionHandle('opt-sg-4'),
    target: 'scene-8',
    type: 'branch',
    data: { optionLabel: '不原谅' },
  },
]

