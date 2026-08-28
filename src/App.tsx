import { useCallback, useEffect, useState } from 'react'
import HomePage from './home/HomePage'
import { projectStore, type ProjectContent } from './projectStore'
import { EMPTY_SETTINGS } from './editor/settings'
import EditorView from './editor/EditorView'
import SettingsView from './settings/SettingsView'
import type { ProjectSummary } from './home/projects'

/** 编辑器态：已加载的项目（id + 名称 + 画布文档）。 */
interface OpenProject {
  id: string
  doc: ProjectContent
}

/**
 * 应用根组件：文档式双界面（docs/ui-design.md §3.1）+ 设置界面——
 * 项目首页 / 编辑器是同一窗口的两种状态，设置页经 ⌘, 叠加打开
 * （独立窗口形态随桌面端演进升级），关闭后回到原界面。
 * 项目数据经 projectStore 持久化（Tauri 落盘 / 浏览器内存回退）。
 */
export default function App() {
  const [projects, setProjects] = useState<ProjectSummary[]>([])
  const [openProject, setOpenProject] = useState<OpenProject | null>(null)
  const [loading, setLoading] = useState(true)
  const [settingsOpen, setSettingsOpen] = useState(false)

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

  // ⌘, 打开设置（macOS 惯例，§8.2）；输入控件聚焦时不触发
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === ',' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault()
        setSettingsOpen(true)
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [])

  const handleCreateProject = useCallback(async () => {
    const meta = await projectStore.create('未命名短剧')
    setOpenProject({
      id: meta.id,
      doc: { name: meta.name, nodes: [], edges: [], settings: { ...EMPTY_SETTINGS } },
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
    (id: string) => (doc: ProjectContent) => {
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

  if (settingsOpen) {
    return <SettingsView onClose={() => setSettingsOpen(false)} />
  }

  if (openProject) {
    return (
      <EditorView
        key={openProject.id}
        project={{ id: openProject.id, ...openProject.doc }}
        onBackHome={handleBackHome}
        onRenameProject={handleEditorRename}
        onOpenSettings={() => setSettingsOpen(true)}
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
