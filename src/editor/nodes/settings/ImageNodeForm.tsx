import { useEffect, useState } from 'react'
import Field from './Field'
import { useNodeEdit } from '../../nodeEdit'
import { useImageJobs } from '../../imagegen/context'
import { IMAGE_SIZES } from '../../imagegen/plan'
import { settingsStore } from '../../../settings/settingsStore'
import { listChatModels, type AppSettings } from '../../../settings/types'
import type { ImageNodeData } from '../types'

/** 尺寸档位的人读标签：竖版贴短剧画幅作为默认推荐。 */
const SIZE_LABELS: Record<(typeof IMAGE_SIZES)[number], string> = {
  '1024x1024': '1024 × 1024 · 方图',
  '1024x1536': '1024 × 1536 · 竖版（短剧）',
  '1536x1024': '1536 × 1024 · 横版',
}

/**
 * 图片节点 ⚙️ 表单（docs/data-model.md §13 文生图首版）：Prompt / 模型 /
 * 尺寸 + 生成与取消。模型下拉与 ✦AI 面板同源（listChatModels 的三层过滤
 * 枚举），空值 = 跟随设置页默认图像模型；生成中的取消为协作式（Rust 侧
 * 放弃结果）；作业失败文案就地展示。
 */
export default function ImageNodeForm({ node }: { readonly node: { readonly id: string; readonly data: ImageNodeData } }) {
  const { patchNode } = useNodeEdit()
  const { jobOf, start, cancel } = useImageJobs()
  const [appSettings, setAppSettings] = useState<AppSettings | null>(null)
  useEffect(() => {
    void settingsStore.load().then(setAppSettings)
  }, [])
  const options = appSettings !== null ? listChatModels(appSettings) : []
  const job = jobOf(node.id)
  const d = node.data

  return (
    <>
      <Field label="PROMPT（画面描述）">
        <textarea
          className="pw-set-input"
          rows={4}
          value={d.prompt}
          placeholder="要生成的画面：角色定妆、场景概念、分镜关键帧…"
          onChange={(e) => patchNode(node.id, { prompt: e.target.value })}
        />
      </Field>
      <Field label="模型（空 = 跟随默认图像模型）">
        <select
          className="pw-set-input"
          value={d.model}
          onChange={(e) => patchNode(node.id, { model: e.target.value })}
        >
          <option value="">跟随默认</option>
          {options.map((o) => (
            <option key={o.key} value={o.key}>
              {o.providerLabel} · {o.model}
            </option>
          ))}
        </select>
      </Field>
      <Field label="尺寸">
        <select
          className="pw-set-input"
          value={d.size}
          onChange={(e) => patchNode(node.id, { size: e.target.value })}
        >
          {IMAGE_SIZES.map((s) => (
            <option key={s} value={s}>
              {SIZE_LABELS[s]}
            </option>
          ))}
        </select>
      </Field>
      {job?.status === 'running' ? (
        <button type="button" className="pw-set-add" onClick={() => cancel(node.id)}>
          ■ 取消生成
        </button>
      ) : (
        <button type="button" className="pw-set-add" onClick={() => start(node.id)}>
          ✦ 生成图片
        </button>
      )}
      {job?.status === 'error' && <p className="pw-set-empty">{job.message}</p>}
      <p className="pw-set-empty">
        生成输入（Prompt/模型/尺寸）变化后，进行中的结果将被丢弃，防旧结果覆盖新编辑。
      </p>
    </>
  )
}
