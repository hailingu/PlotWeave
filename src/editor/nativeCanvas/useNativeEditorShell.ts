import { useEffect, useRef } from 'react'
import { flushSync } from 'react-dom'
import { currentNativeNode, nativeNodePatch } from './nativeNodeActions'
import type { ReactFlowInstance } from '@xyflow/react'
import { isSwiftHost } from '../../platform/hostEnvironment'
import {
  publishNativeProjection,
  registerNativeIntentHandler,
} from '../../platform/nativeShell'
import { buildOutlineGroups } from '../outline'
import { nodeLabelOf } from '../useAiBridge'
import type { EditorController } from '../useEditorController'
import type { CanvasNode } from '../nodes/types'
import type { CanvasAlignment } from '../canvasAlignment'
import { nativeEditorExtra } from './nativeEditorActions'
import type { EditorProjectContent } from '../useEditorDocument'

/** Current editor action ownership, plus view-only native zoom commands. */
interface NativeEditorInput {
  projectId: string
  project: EditorProjectContent
  aiSessionLoadFailed: boolean
  aiSessionError: string | null
  editor: EditorController
  viewport: Pick<ReactFlowInstance, 'zoomIn' | 'zoomOut' | 'fitView'>
}

/** Rejects non-text identities before dispatching a native edit. */
function requiredText(args: Record<string, unknown>, key: string): string {
  const value = args[key]
  if (typeof value !== 'string' || value.length === 0)
    throw new Error(`无效参数：${key}`)
  return value
}

/** Node type names are a wire contract; unknown types never create fallback nodes. */
function nodeType(value: unknown): CanvasNode['type'] {
  switch (value) {
    case 'scene':
    case 'beat':
    case 'dialogue':
    case 'branch':
    case 'shot':
    case 'image':
      return value
    default:
      throw new Error('不支持的节点类型。')
  }
}

/** Routes graph edits through the production controller's shared history. */
function graphIntent(
  editor: EditorController,
  command: string,
  args: Record<string, unknown>,
): boolean {
  switch (command) {
    case 'editor.undo':
      editor.history.undo()
      break
    case 'editor.redo':
      editor.history.onRedo()
      break
    case 'editor.create':
      editor.graph.creation.createNode(nodeType(args.nodeType))
      break
    case 'editor.patchNode':
      nativeNodePatch(editor, args)
      break
    case 'editor.select': {
      const id = currentNativeNode(editor, args).id
      editor.view.locateNode(id)
      editor.panels.toggleSettings(id)
      break
    }
    case 'editor.delete':
      editor.graph.deleteNodesByIds([currentNativeNode(editor, args).id])
      break
    case 'editor.duplicate':
      editor.graph.creation.duplicateNode(currentNativeNode(editor, args).id)
      break
    case 'editor.nodeSettings':
      editor.panels.toggleSettings(currentNativeNode(editor, args).id)
      break
    case 'editor.layout':
      editor.graph.layout.onAutoLayout()
      break
    case 'editor.align': {
      const alignment = requiredText(args, 'alignment')
      if (
        !['left', 'center', 'right', 'top', 'middle', 'bottom'].includes(
          alignment,
        )
      )
        throw new Error('无效对齐方式。')
      editor.graph.alignment.onAlignNodes(alignment as CanvasAlignment)
      break
    }
    default:
      return false
  }
  return true
}

/** Panel commands change visibility only; opening auxiliary UI keeps the document alive. */
function panelIntent(input: NativeEditorInput, command: string): unknown {
  const { panels } = input.editor
  switch (command) {
    case 'editor.export':
      panels.setExportOpen(true)
      return null
    case 'editor.ai':
      panels.toggleRight('ai')
      return null
    case 'editor.library':
      panels.setLeftOpen((open) => !open)
      return null
    case 'editor.zoomIn':
      return input.viewport.zoomIn()
    case 'editor.zoomOut':
      return input.viewport.zoomOut()
    case 'editor.fit':
      return input.viewport.fitView()
    default:
      throw new Error('当前编辑器不支持此命令。')
  }
}

/** Enforces project identity even when the page session itself is still valid. */
function execute(
  input: NativeEditorInput,
  command: string,
  args: Record<string, unknown>,
  isCurrent: () => boolean,
): unknown {
  if (args.projectId !== input.projectId)
    throw new Error('命令目标项目已过时。')
  const extra = nativeEditorExtra({ ...input, isCurrent }, command, args)
  if (extra.handled) return extra.value ?? null
  if (graphIntent(input.editor, command, args)) return null
  return panelIntent(input, command)
}

/** One existing node supplies read-only native field preparation without changing selection or history. */
function inspectorNode(node: CanvasNode | undefined) {
  return node ? { id: node.id, type: node.type, data: node.data } : null
}

/** One representative per existing kind prepares bounded native controls; selected data already travels separately. */
function inspectorSeeds(nodes: CanvasNode[], selected: CanvasNode | undefined) {
  const seen = new Set<CanvasNode['type']>()
  if (selected) seen.add(selected.type)
  const seeds: NonNullable<ReturnType<typeof inspectorNode>>[] = []
  for (const node of nodes) {
    if (seen.has(node.type)) continue
    seen.add(node.type)
    seeds.push({ id: node.id, type: node.type, data: node.data })
  }
  return seeds
}

/** Projects data needed by native chrome; continuous graph positions stay in Web. */
function snapshot(input: NativeEditorInput, contentRevision: number) {
  const { doc, history, persistence, view, panels } = input.editor
  const selected =
    doc.nodes.find((node) => node.id === panels.openSettingsId) ??
    view.selectedNode
  return {
    aiSessionLoadFailed: input.aiSessionLoadFailed,
    aiSessionError: input.aiSessionError,
    projectId: input.projectId,
    contentRevision,
    canUndo: history.canUndo,
    canRedo: history.canRedo,
    saveError: persistence.saveError,
    editingNodeId: panels.openSettingsId,
    nodeSettingsRequest: panels.nodeSettingsRequest,
    selected: inspectorNode(selected),
    inspectorSeeds: inspectorSeeds(doc.contentNodes, selected),
    nodes: doc.contentNodes.map((node) => ({
      id: node.id,
      type: node.type,
      label: nodeLabelOf(node),
    })),
    outline: buildOutlineGroups(doc.nodes, doc.edges, doc.episodeTitles),
    settings: doc.settings,
    assets: doc.assets,
    focusedEpisode: doc.focusedEpisode,
    zoom: doc.viewport?.zoom ?? 1,
    aiOpen: panels.rightOpen && panels.rightTab === 'ai',
  }
}

/** Stable native action owner and deduplicated read-only projection for a live editor. */
export function useNativeEditorShell(input: NativeEditorInput): void {
  const latest = useRef(input)
  latest.current = input
  useEffect(() => {
    if (!isSwiftHost()) return
    let alive = true
    const remove = registerNativeIntentHandler('editor', (command, args) => {
      let value: unknown
      // Acknowledgment follows React's commit, so the next native request reads current refs.
      flushSync(() => {
        value = execute(latest.current, command, args, () => alive)
      })
      return value
    })
    return () => {
      alive = false
      remove()
    }
  }, [])
  const revision = useRef<{ sources: readonly unknown[]; value: number }>({
    sources: [],
    value: 0,
  })
  const doc = input.editor.doc
  const sources = [
    doc.contentNodes,
    doc.edges,
    doc.settings,
    doc.assets,
    doc.episodeTitles,
    doc.viewport,
    input.project.name,
  ]
  if (sources.some((value, index) => value !== revision.current.sources[index]))
    revision.current = { sources, value: revision.current.value + 1 }
  const encoded = isSwiftHost()
    ? JSON.stringify(snapshot(input, revision.current.value))
    : ''
  useEffect(() => {
    if (encoded)
      publishNativeProjection('editor', JSON.parse(encoded) as unknown)
  }, [encoded])
}
