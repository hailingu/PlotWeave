/**
 * 生成计划解析（docs/data-model.md §13 文生图）：发起前把节点的生成输入
 * 解析为可执行的 provider/model/size 组合。模型选择的优先级：
 * 节点显式 model > AppSettings.defaultImage；两者都不可用时返回可行动的
 * 失败文案（引导去设置页配置）。纯函数，供生成调度与测试共用。
 */
import {
  resolveImageModel,
  type AppSettings,
  type ProviderConfig,
} from '../../settings/types'
import type { ImageNodeData } from '../nodes/types'

/** 尺寸档位（OpenAI 兼容 images API 通行三档）：方图 / 竖版（短剧优先）/
 * 横版。竖版 2:3 贴近短剧画幅，作为默认档。 */
export const IMAGE_SIZES = ['1024x1024', '1024x1536', '1536x1024'] as const

/** 解析结果：可执行的生成计划（ok 分支）或面向用户的失败文案。 */
export type ImageGenPlanResult =
  | { ok: true; provider: ProviderConfig; model: string; prompt: string; size: string }
  | { ok: false; message: string }

/** 按优先级解析节点输入 → 生成计划；prompt 空白也在此拒绝。 */
export function resolveImageGenPlan(
  data: Pick<ImageNodeData, 'prompt' | 'model' | 'size'>,
  settings: AppSettings,
): ImageGenPlanResult {
  const prompt = data.prompt.trim()
  if (prompt === '') {
    return { ok: false, message: 'Prompt 不能为空，请在 ⚙️ 面板填写画面描述。' }
  }
  const model = data.model !== '' ? data.model : settings.defaultImage
  const resolved =
    model !== null ? resolveImageModel({ ...settings, defaultImage: model }) : null
  if (model === null || resolved === null) {
    return {
      ok: false,
      message: model
        ? `模型 ${model} 当前不可用（provider 未启用或模型已移出清单），请重新选择。`
        : '尚未配置图像生成模型：请在设置页的「默认模型」分段选择，或在节点 ⚙️ 面板指定。',
    }
  }
  return {
    ok: true,
    provider: resolved.provider,
    model: resolved.model,
    prompt,
    size: data.size,
  }
}
