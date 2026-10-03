/** 结构化剧本导出：复用现有项目文档契约，保留完整图与引用，不打包媒体文件。 */
import { serializeProject } from '../model/serialize'
import {
  sessionDoc,
  type EditorProject,
  type SessionDocPart,
} from './sessionDoc'

/**
 * 把当前会话转换为 ProjectDocument JSON。与保存共用字段透传和语义序列化，
 * 文档时间由调用方经 project 元数据显式注入，不读取导出时钟。保留加载时的
 * 修改时间；兼容输入缺省时取创建时间，再回退 epoch，保证同一会话跨日稳定。
 * 不修改会话或触发保存；保存时的更新时间盖戳仍归 serializeProject 所有。
 */
export function buildScriptJson(
  project: EditorProject,
  current: SessionDocPart,
): string {
  const document = serializeProject(
    sessionDoc(project, current),
    project.id,
    new Date(project.updatedAt ?? project.createdAt ?? 0),
  )
  return `${JSON.stringify(document, null, 2)}\n`
}
