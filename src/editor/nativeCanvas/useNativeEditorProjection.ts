/** Memoized read-only native chrome; graph coordinates remain owned by the Web document. */
import { useMemo, useState } from 'react'
import { isSwiftHost } from '../../platform/hostEnvironment'
import { useOutlineGroups } from '../useOutlineGroups'
import { nodeLabelOf } from '../useAiBridge'
import type { EditorController } from '../useEditorController'
import type { EditorProjectContent } from '../useEditorDocument'
import type { OutlineGroup } from '../outline'
import type { ProjectContent } from '../../model/content'
import type { ProjectSettings } from '../settings'
import type { CanvasNode } from '../nodes/types'

const DISABLED_NODES: CanvasNode[] = []
const DISABLED_SOURCES: readonly unknown[] = []

/** One representative per existing kind prepares controls without selecting or editing nodes. */
export interface NativeInspectorSeed {
  id: string
  type: CanvasNode['type']
  data: CanvasNode['data']
}

/** Labelled node identity the native outline and toolbar render instead of graph coordinates. */
export interface NativeNodeSummary {
  id: string
  type: CanvasNode['type']
  label: string
}

/** Structured editor chrome published to the Swift host; field identities drive payload reuse. */
export interface NativeEditorProjection {
  aiSessionLoadFailed: boolean
  aiSessionError: string | null
  projectId: string
  contentRevision: number
  canUndo: boolean
  canRedo: boolean
  saveError: string | null
  editingNodeId: string | null
  nodeSettingsRequest: number
  selected: NativeInspectorSeed | null
  inspectorSeeds: NativeInspectorSeed[]
  nodes: NativeNodeSummary[]
  outline: OutlineGroup[]
  settings: ProjectSettings
  assets: ProjectContent['assets']
  focusedEpisode: number | null
  zoom: number
  aiOpen: boolean
}

/** Projection fields come from the existing controller, never a second editable document. */
interface ProjectionInput {
  projectId: string
  project: EditorProjectContent
  aiSessionLoadFailed: boolean
  aiSessionError: string | null
  editor: EditorController
}

/** Revision follows content/viewport identities and rolls back with abandoned renders. */
function useContentRevision(sources: readonly unknown[]) {
  const [revision, setRevision] = useState({ sources, value: 1 })
  if (sources.some((value, index) => value !== revision.sources[index])) {
    const next = { sources, value: revision.value + 1 }
    setRevision(next)
    return next.value
  }
  return revision.value
}

/** One representative per existing kind prepares controls without selecting or editing nodes. */
function inspectorSeeds(
  nodes: CanvasNode[],
  selectedType: CanvasNode['type'] | undefined,
) {
  const seen = new Set<CanvasNode['type']>()
  if (selectedType) seen.add(selectedType)
  const seeds: NativeInspectorSeed[] = []
  for (const node of nodes) {
    if (seen.has(node.type)) continue
    seen.add(node.type)
    seeds.push({ id: node.id, type: node.type, data: node.data })
  }
  return seeds
}

/** Expensive content projections have semantic inputs independent of position/session frames. */
function useContentProjection(input: ProjectionInput, enabled: boolean) {
  const { doc, panels, view } = input.editor
  const contentNodes = enabled ? doc.contentNodes : DISABLED_NODES
  const target = enabled
    ? (doc.nodes.find((node) => node.id === panels.openSettingsId) ??
      view.selectedNode)
    : undefined
  const id = target?.id,
    type = target?.type,
    data = target?.data
  const selected = useMemo(
    () =>
      id !== undefined && type !== undefined && data !== undefined
        ? { id, type, data }
        : null,
    [id, type, data],
  )
  const seeds = useMemo(
    () => (enabled ? inspectorSeeds(contentNodes, type) : []),
    [enabled, contentNodes, type],
  )
  const nodes = useMemo(
    () =>
      enabled
        ? contentNodes.map((node) => ({
            id: node.id,
            type: node.type,
            label: nodeLabelOf(node),
          }))
        : [],
    [enabled, contentNodes],
  )
  const outline = useOutlineGroups(
    enabled ? doc.nodes : DISABLED_NODES,
    contentNodes,
    doc.edges,
    doc.episodeTitles,
    enabled,
  )
  const contentRevision = useContentRevision(
    enabled
      ? [
          doc.contentNodes,
          doc.edges,
          doc.settings,
          doc.assets,
          doc.episodeTitles,
          doc.viewport,
          input.project.name,
        ]
      : DISABLED_SOURCES,
  )
  return { selected, seeds, nodes, outline, contentRevision }
}

/**
 * Rebuilds the payload object only when a wire field identity changes and stays
 * null off a Swift host. Publishing follows payload identity, which reproduces
 * the former whole-string byte dedup: every heavy field (nodes, seeds, outline)
 * re-derives only after its sources churn, and those same sources feed the
 * identity-keyed contentRevision, so a rebuild always coincides with a content
 * change. The payload crosses to the host as a structured value — WebKit
 * serializes it once, with no stringify/parse round-trip in between (issue #728).
 */
export function useNativeEditorProjection(
  input: ProjectionInput,
): NativeEditorProjection | null {
  const enabled = isSwiftHost()
  const { projectId, aiSessionLoadFailed, aiSessionError } = input
  const { doc, history, persistence, panels } = input.editor
  const { selected, seeds, nodes, outline, contentRevision } =
    useContentProjection(input, enabled)
  const { canUndo, canRedo } = history
  const { saveError } = persistence
  const { openSettingsId, nodeSettingsRequest } = panels
  const { settings, assets, focusedEpisode } = doc
  const zoom = doc.viewport?.zoom ?? 1
  const aiOpen = panels.rightOpen && panels.rightTab === 'ai'
  return useMemo(
    () =>
      enabled
        ? {
            aiSessionLoadFailed,
            aiSessionError,
            projectId,
            contentRevision,
            canUndo,
            canRedo,
            saveError,
            editingNodeId: openSettingsId,
            nodeSettingsRequest,
            selected,
            inspectorSeeds: seeds,
            nodes,
            outline,
            settings,
            assets,
            focusedEpisode,
            zoom,
            aiOpen,
          }
        : null,
    [
      enabled,
      aiSessionLoadFailed,
      aiSessionError,
      projectId,
      contentRevision,
      canUndo,
      canRedo,
      saveError,
      openSettingsId,
      nodeSettingsRequest,
      selected,
      seeds,
      nodes,
      outline,
      settings,
      assets,
      focusedEpisode,
      zoom,
      aiOpen,
    ],
  )
}
