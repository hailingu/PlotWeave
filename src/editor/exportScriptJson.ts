/** 结构化剧本导出：复用现有项目文档契约，保留完整图与引用，不打包媒体文件。 */
import { serializeProject } from '../model/serialize'
import {
  sessionDoc,
  type EditorProject,
  type SessionDocPart,
} from './sessionDoc'

/**
 * 把当前会话转换为 ProjectDocument JSON。与保存共用字段透传和语义序列化，
 * 时间由调用方显式注入；相同输入稳定输出，不修改会话或触发保存。
 */
export function buildScriptJson(
  project: EditorProject,
  current: SessionDocPart,
  exportedAt: Date,
): string {
  const document = serializeProject(
    sessionDoc(project, current),
    project.id,
    exportedAt,
  )
  return `${JSON.stringify(document, null, 2)}\n`
}
