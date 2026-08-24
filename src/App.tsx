import { useCallback, useState } from 'react'
import HomePage from './home/HomePage'
import { createSampleProjects, type ProjectSummary } from './home/projects'
import EditorView from './editor/EditorView'

/**
 * 应用根组件：文档式双界面（docs/ui-design.md §3.1）——
 * 项目首页与编辑器是同一窗口的两种状态，`openProjectId` 非空即编辑器。
 * 项目数据目前为内存占位，持久化命令（list_projects 等）落地后改由后端驱动。
 */
export default function App() {
  const [projects, setProjects] = useState<ProjectSummary[]>(() =>
    createSampleProjects(),
  )
  const [openProjectId, setOpenProjectId] = useState<string | null>(null)

  const handleCreateProject = useCallback(() => {
    const project: ProjectSummary = {
      id: `local-${Date.now()}`,
      name: '未命名短剧',
      sceneCount: 0,
      updatedAt: new Date().toISOString(),
    }
    setProjects((list) => [project, ...list])
    setOpenProjectId(project.id)
  }, [])

  const openProject = projects.find((p) => p.id === openProjectId)
  if (openProject) {
    return (
      <EditorView
        projectName={openProject.name}
        onBackHome={() => setOpenProjectId(null)}
      />
    )
  }
  return (
    <HomePage
      projects={projects}
      onOpenProject={setOpenProjectId}
      onCreateProject={handleCreateProject}
    />
  )
}
