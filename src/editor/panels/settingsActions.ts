/**
 * 设定集条目编辑动作契约（issue 106 从 LeftPanel.tsx 抽出的稳定契约模块）：
 * 左栏外壳（LeftPanel）、设定集列表（SettingsList）与生产方
 * （useSettingsActions / useEditorGraphActions）共同依赖的单向接口。
 * 增/改名/删全部走命令栈可撤销（§5）；issue 56 增文档；issue 95 增人工
 * 详情保存：名称+描述整体 patch，实体缺失时零派发。
 */

/** 设定集条目编辑动作（§5）。 */
export interface SettingsActions {
  addCharacter: () => void
  renameCharacter: (id: string, name: string) => void
  deleteCharacter: (id: string) => void
  /** 保存角色详情（名称/小传整体 patch，issue 95）。 */
  updateCharacter: (id: string, patch: { name?: string; bio?: string }) => void
  addLocation: () => void
  renameLocation: (id: string, name: string) => void
  deleteLocation: (id: string) => void
  /** 保存地点详情（名称/备注整体 patch，issue 95）。 */
  updateLocation: (id: string, patch: { name?: string; note?: string }) => void
  /** 新建占位文档（issue 56）。 */
  addDocument: () => void
  /** 保存文档编辑（标题/正文/关联整体 patch）。 */
  updateDocument: (
    id: string,
    patch: {
      title?: string
      body?: string
      relatedIds?: Array<{ kind: 'character' | 'location'; id: string }>
    },
  ) => void
  deleteDocument: (id: string) => void
}
