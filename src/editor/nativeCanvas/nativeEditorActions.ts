import { nativeLibraryBinding } from './nativeLibraryBinding'
import { nativeNodeExtra } from './nativeNodeActions'
import { buildScriptExport } from '../exportScript'
import { buildScriptJson } from '../exportScriptJson'

import type { NativeEditorActionOwner } from './nativeEditorOwner'

/** Exports the live document through existing pure generators; no storage write or media packing occurs. */
function exportPreview(
  owner: NativeEditorActionOwner,
  args: Record<string, unknown>,
) {
  const doc = owner.editor.doc
  const current = {
    nodes: doc.nodesRef.current,
    edges: doc.edgesRef.current,
    settings: doc.settingsRef.current,
    assets: doc.assetsRef.current,
    episodeTitles: doc.episodeTitlesRef.current,
    viewport: doc.viewportRef.current,
    aiRevision: doc.aiRevision,
  }
  if (args.format !== 'md' && args.format !== 'json')
    throw new Error('导出格式无效。')
  const markdown = buildScriptExport({
    projectName: owner.project.name,
    ...current,
  })
  let text = markdown.outline
  if (args.format === 'json') text = buildScriptJson(owner.project, current)
  else if (args.outline === false) text = markdown.plain
  const name = Array.from(owner.project.name, (character) =>
    character === '/' ||
    character === '\\' ||
    (character.codePointAt(0) ?? 0) < 32
      ? '_'
      : character,
  ).join('')
  return {
    text,
    fileName: `${name}-剧本.${args.format}`,
    format: args.format,
    scope:
      args.format === 'json'
        ? '完整画布 · 设定集 · 资产索引（不含媒体和 AI 会话）'
        : markdown.scopeLine,
  }
}

/** Existing entity buckets and IDs are the only accepted native mutation targets. */
function entityKind(value: unknown): 'character' | 'location' | 'document' {
  if (value === 'character' || value === 'location' || value === 'document')
    return value
  throw new Error('未知的设定实体类型。')
}

/** A stale form cannot recreate a deleted entity, even when its page session remains alive. */
function currentEntity(
  owner: NativeEditorActionOwner,
  kind: ReturnType<typeof entityKind>,
  id: unknown,
): string {
  const settings = owner.editor.doc.settingsRef.current
  const items = {
    character: settings.characters,
    location: settings.locations,
    document: settings.documents ?? [],
  }[kind]
  if (typeof id !== 'string' || !items.some((entity) => entity.id === id))
    throw new Error('设定条目已删除，请重新选择。')
  return id
}

/** Provider-independent entity patches reuse domain validators then ordinary settings history, without AI revision changes. */
function updateEntity(
  owner: NativeEditorActionOwner,
  kind: ReturnType<typeof entityKind>,
  id: string,
  fields: unknown,
): void {
  const operations = {
    character: 'upsert_character',
    location: 'upsert_location',
    document: 'upsert_document',
  } as const
  const validation = owner.editor.ai.validateCommands([
    {
      op: operations[kind],
      entityId: id,
      fields,
    },
  ])
  const command = validation?.commands[0]
  if (!validation?.ok || !command)
    throw new Error(
      validation?.issues.map((issue) => issue.message).join('；') ||
        '设定字段无效。',
    )
  const actions = owner.editor.graph.settingsActions
  if (command.op === 'upsert_character')
    actions.updateCharacter(id, command.fields)
  else if (command.op === 'upsert_location')
    actions.updateLocation(id, command.fields)
  else if (command.op === 'upsert_document')
    actions.updateDocument(id, command.fields)
  else throw new Error('设定修改无法匹配目标。')
}

/** Routes creation/deletion through the same actions as dev's settings list. */
function entityAction(
  owner: NativeEditorActionOwner,
  command: string,
  args: Record<string, unknown>,
): void {
  const kind = entityKind(args.kind)
  const actions = owner.editor.graph.settingsActions
  if (command === 'editor.entityCreate') {
    if (kind === 'character') actions.addCharacter()
    else if (kind === 'location') actions.addLocation()
    else actions.addDocument()
    return
  }
  const id = currentEntity(owner, kind, args.id)
  if (command === 'editor.entityUpdate') {
    updateEntity(owner, kind, id, args.patch)
    return
  }
  if (kind === 'character') actions.deleteCharacter(id)
  else if (kind === 'location') actions.deleteLocation(id)
  else actions.deleteDocument(id)
}

/** Handles native settings, episode, outline and export operations without introducing a second document store. */
export function nativeEditorExtra(
  owner: NativeEditorActionOwner,
  command: string,
  args: Record<string, unknown>,
): { handled: boolean; value?: unknown } {
  if (command === 'editor.toggleDocumentRelation') {
    toggleRelation(owner, args)
    return { handled: true }
  }
  if (command === 'editor.outlineMove') {
    outlineMove(owner, args)
    return { handled: true }
  }
  if (command === 'editor.importLibraryAsset')
    return { handled: true, value: nativeLibraryBinding(owner, args) }
  if (nativeNodeExtra(owner.editor, command, args)) return { handled: true }
  if (command === 'editor.exportPreview')
    return { handled: true, value: exportPreview(owner, args) }
  if (
    [
      'editor.entityCreate',
      'editor.entityUpdate',
      'editor.entityDelete',
    ].includes(command)
  ) {
    entityAction(owner, command, args)
    return { handled: true }
  }
  if (command === 'editor.episodeRename' || command === 'editor.episodeFocus') {
    episodeAction(owner, command, args)
    return { handled: true }
  }
  return { handled: false }
}

/** Episode mutations share one validation boundary and the existing graph/history owner. */
function episodeAction(
  owner: NativeEditorActionOwner,
  command: string,
  args: Record<string, unknown>,
): void {
  const episode = args.episode
  if (
    episode !== null &&
    (typeof episode !== 'number' ||
      !Number.isSafeInteger(episode) ||
      episode < 1)
  )
    throw new Error('无效集号。')
  if (command === 'editor.episodeFocus') {
    owner.editor.graph.episodes.toggleEpisodeFocus(episode as number | null)
    return
  }
  if (episode === null || typeof args.title !== 'string')
    throw new Error('集名称无效。')
  owner.editor.graph.episodes.renameEpisode(episode as number, args.title)
}

/** Document links toggle only a live entity, retaining all unrelated current relationships. */
function toggleRelation(
  owner: NativeEditorActionOwner,
  args: Record<string, unknown>,
): void {
  const kind = entityKind(args.kind)
  if (kind === 'document') throw new Error('文档关联仅支持角色和地点。')
  const id = currentEntity(owner, 'document', args.id)
  const entityId = currentEntity(owner, kind, args.entityId)
  const document = owner.editor.doc.settingsRef.current.documents?.find(
    (item) => item.id === id,
  )
  if (!document) throw new Error('设定文档已删除。')
  const before = document.relatedIds
  const exists = before.some(
    (item) => item.kind === kind && item.id === entityId,
  )
  owner.editor.graph.settingsActions.updateDocument(id, {
    relatedIds: exists
      ? before.filter((item) => item.kind !== kind || item.id !== entityId)
      : [...before, { kind, id: entityId }],
  })
}

/** Outline moves validate both stable endpoints before using dev's edge/episode compound history. */
function outlineMove(
  owner: NativeEditorActionOwner,
  args: Record<string, unknown>,
): void {
  const node = owner.editor.doc.nodesRef.current.find(
    (item) => item.id === args.id,
  )
  const target = args.target
  if (
    !node ||
    node.type === 'shot' ||
    node.type === 'image' ||
    !target ||
    typeof target !== 'object' ||
    Array.isArray(target)
  )
    throw new Error('大纲拖放目标无效。')
  const value = target as Record<string, unknown>
  if (
    value.kind === 'row' &&
    typeof value.anchorId === 'string' &&
    (value.position === 'before' || value.position === 'after')
  ) {
    if (
      !owner.editor.doc.nodesRef.current.some(
        (item) => item.id === value.anchorId,
      )
    )
      throw new Error('大纲锚点已删除。')
    owner.editor.graph.outlineDrop(node.id, {
      kind: 'row',
      anchorId: value.anchorId,
      position: value.position,
    })
  } else if (
    value.kind === 'groupEnd' &&
    (value.episode === null ||
      (typeof value.episode === 'number' &&
        Number.isSafeInteger(value.episode) &&
        value.episode > 0))
  ) {
    owner.editor.graph.outlineDrop(node.id, {
      kind: 'groupEnd',
      episode: value.episode,
    })
  } else throw new Error('大纲落点无效。')
}
