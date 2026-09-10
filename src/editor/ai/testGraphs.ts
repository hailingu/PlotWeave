import type { AiGraphSnapshot } from './commands'

/**
 * AI 批命令校验测试的共享图快照夹具（issue 68）：commands.test.ts 与
 * commands.contingent.test.ts 的单一来源，避免各测试文件复制漂移；
 * 仅服务测试，不进运行时调用图。
 */

/** 测试用快照：节拍 n2 → 场景 n1 的两节点剧情流（无资产）。 */
export function snap(): AiGraphSnapshot {
  return {
    nodes: [
      { id: 'n1', type: 'scene', label: '场 01 · 天台' },
      { id: 'n2', type: 'beat', label: '节拍 · 开端' },
    ],
    edges: [{ source: 'n2', target: 'n1' }],
    assets: new Map(),
  }
}

/** 测试用快照：场景 s1 下挂分镜 sh1，分支 b1（两个选项）；含 image/audio 资产。 */
export function richSnap(): AiGraphSnapshot {
  return {
    nodes: [
      { id: 's1', type: 'scene', label: '场 01 · 天台' },
      { id: 'sh1', type: 'shot', label: 'SHOT01·中景' },
      {
        id: 'b1',
        type: 'branch',
        label: '分支 · 追或不追？',
        options: [
          { id: 'ob-a', label: '追' },
          { id: 'ob-b', label: '不追' },
        ],
      },
    ],
    edges: [],
    assets: new Map([
      ['a-img', 'image/png'],
      ['a-aud', 'audio/mpeg'],
    ]),
  }
}
