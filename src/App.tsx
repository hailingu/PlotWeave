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
    />
  )
}
