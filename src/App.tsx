import { useCallback, useEffect, useState } from 'react'
import HomePage from './home/HomePage'
import { projectStore, type ProjectDocument } from './projectStore'
import EditorView from './editor/EditorView'
import type { ProjectSummary } from './home/projects'

/** 编辑器态：已加载的项目（id + 名称 + 画布文档）。 */
interface OpenProject {
  id: string
  doc: ProjectDocument
}

/**
 * 应用根组件：文档式双界面（docs/ui-design.md §3.1）——
 * 项目首页与编辑器是同一窗口的两种状态，openProject 非空即编辑器。
 * 项目数据经 projectStore 持久化（Tauri 落盘 / 浏览器内存回退）；
 * 返回首页时刷新列表，统计与更新时间随画布保存即时反映。
 */
export default function App() {
  const [projects, setProjects] = useState<ProjectSummary[]>([])
  const [openProject, setOpenProject] = useState<OpenProject | null>(null)
  const [loading, setLoading] = useState(true)

  const refreshProjects = useCallback(async () => {
    try {
      setProjects(await projectStore.list())
    } catch (err) {
      console.warn('[App] 项目列表加载失败', err)
      setProjects([])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refreshProjects()
  }, [refreshProjects])

  const handleCreateProject = useCallback(async () => {
    const meta = await projectStore.create('未命名短剧')
    setOpenProject({
      id: meta.id,
      doc: { name: meta.name, nodes: [], edges: [] },
    })
    void refreshProjects()
  }, [refreshProjects])

  const handleOpenProject = useCallback(
    async (id: string) => {
      try {
        const doc = await projectStore.load(id)
        setOpenProject({ id, doc })
      } catch (err) {
        console.warn('[App] 打开项目失败', err)
      }
    },
    [],
  )

  const handleBackHome = useCallback(() => {
    setOpenProject(null)
    void refreshProjects()
  }, [refreshProjects])

  const handleSave = useCallback(
    (id: string) => (doc: ProjectDocument) => {
      void projectStore.saveQuiet(id, doc)
    },
    [],
  )

  /** 编辑器工具栏项目名内联改名（§3.3）：更新打开态，随防抖落盘。 */
  const handleEditorRename = useCallback((name: string) => {
    setOpenProject((p) => (p ? { ...p, doc: { ...p.doc, name } } : p))
  }, [])

  /** 首页卡片菜单 · 重命名（§3.2）：读原文档改 name 后保存。 */
  const handleRenameProject = useCallback(
    async (id: string, name: string) => {
      try {
        const doc = await projectStore.load(id)
        await projectStore.saveQuiet(id, { ...doc, name })
        await refreshProjects()
      } catch (err) {
        console.warn('[App] 重命名失败', err)
      }
    },
    [refreshProjects],
  )

  const handleDuplicateProject = useCallback(
    async (id: string) => {
      try {
        await projectStore.duplicate(id)
        await refreshProjects()
      } catch (err) {
        console.warn('[App] 复制项目失败', err)
      }
    },
    [refreshProjects],
  )

  const handleDeleteProject = useCallback(
    async (id: string) => {
      try {
        await projectStore.delete(id)
        await refreshProjects()
      } catch (err) {
        console.warn('[App] 删除项目失败', err)
      }
    },
    [refreshProjects],
  )

  if (openProject) {
    return (
      <EditorView
        key={openProject.id}
        project={{
          id: openProject.id,
          name: openProject.doc.name,
          nodes: openProject.doc.nodes,
          edges: openProject.doc.edges,
        }}
        onBackHome={handleBackHome}
        onRenameProject={handleEditorRename}
        onSave={handleSave(openProject.id)}
      />
    )
  }
  return (
    <HomePage
      projects={projects}
      loading={loading}
      onOpenProject={handleOpenProject}
      onCreateProject={() => void handleCreateProject()}
      onRenameProject={(id, name) => void handleRenameProject(id, name)}
      onDuplicateProject={(id) => void handleDuplicateProject(id)}
      onDeleteProject={(id) => void handleDeleteProject(id)}
    />
  )
}
