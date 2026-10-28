import type { EditorController } from '../useEditorController'
import type { CanvasNode } from '../nodes/types'
import { dataPatchOf, episodeNoPatch } from '../nodes/patch'
import {
  nativeListPatch,
  validateNativeListMember,
  type NativeListField,
} from './nativeListValidation'
import { uid } from '../../uid'
import { IMAGE_SIZES } from '../imagegen/plan'
import { FREE_TEXT_MAX_CHARS } from '../ai/textBudget'

/** Resolves identity against the current authoritative document before each native mutation. */
export function currentNativeNode(
  editor: EditorController,
  args: Record<string, unknown>,
): CanvasNode {
  const node = editor.doc.nodesRef.current.find(
    (candidate) => candidate.id === args.id,
  )
  if (!node) throw new Error('目标节点已删除，请重新选择。')
  return node
}

/** Reuses domain validation, then ordinary patch history including branch edge cascading. */
export function nativeNodePatch(
  editor: EditorController,
  args: Record<string, unknown>,
): void {
  const node = currentNativeNode(editor, args)
  if (
    typeof args.patch !== 'object' ||
    args.patch === null ||
    Array.isArray(args.patch)
  )
    throw new Error('节点字段必须为对象。')
  if (node.type === 'image') {
    nativeImagePatch(editor, node.id, args.patch as Record<string, unknown>)
    return
  }
  const result = editor.ai.validateCommands([
    {
      op: 'update_node',
      nodeId: node.id,
      patch: args.patch as Record<string, unknown>,
    },
  ])
  const command = result?.commands[0]
  if (!result?.ok || command?.op !== 'update_node')
    throw new Error(
      result?.issues.map((issue) => issue.message).join('；') ||
        '节点字段无效。',
    )
  editor.graph.patch.patchNode(node.id, command.patch)
}

/** List types are coupled to their owning node; a stale or cross-type form is rejected. */
function currentList(
  node: CanvasNode,
  field: unknown,
): { field: NativeListField; items: Array<{ id: string }> } {
  if (node.type === 'dialogue' && field === 'lines')
    return { field, items: node.data.lines }
  if (node.type === 'branch' && field === 'options')
    return { field, items: node.data.options }
  if (node.type === 'shot' && field === 'refs')
    return { field, items: node.data.refs }
  throw new Error('该节点不支持此列表。')
}

/** Native row changes clear mutually exclusive fields using the existing dev form semantics. */
function mergeItem(
  editor: EditorController,
  field: NativeListField,
  item: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  if (field === 'lines') return mergeDialogueItem(editor, item, patch)
  const merged: Record<string, unknown> = { ...item, ...patch }
  if (field === 'refs' && typeof patch.label === 'string') delete merged.assetId
  return merged
}

/** Dialogue kind transitions apply dev's defaults without disturbing explicit field deltas. */
function mergeDialogueItem(
  editor: EditorController,
  item: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...item, ...patch }
  if (patch.kind === 'action') {
    delete merged.speaker
    delete merged.side
  } else if (patch.kind === 'line' && item.kind !== 'line') {
    const first = editor.doc.settingsRef.current.characters[0]?.id
    if (!('side' in patch)) merged.side = 'left'
    if (!('speaker' in patch)) {
      if (first) merged.speaker = first
      else delete merged.speaker
    }
  }
  if (patch.speaker === null) delete merged.speaker
  return merged
}

/** Creates rows with domain defaults rather than trusting arbitrary native array replacements. */
function newItem(
  editor: EditorController,
  field: NativeListField,
): Record<string, unknown> {
  if (field === 'lines') {
    const speaker = editor.doc.settingsRef.current.characters[0]?.id
    return {
      id: uid('line'),
      kind: 'line',
      text: '',
      side: 'left',
      ...(speaker ? { speaker } : {}),
    }
  }
  if (field === 'options') return { id: uid('option'), label: '新选项' }
  return { id: uid('ref'), kind: 'character', label: '' }
}

/** Granular list commands derive from current rows; missing identities cannot be resurrected. */
function listAction(
  editor: EditorController,
  command: string,
  args: Record<string, unknown>,
): void {
  const node = currentNativeNode(editor, args)
  const { field, items } = currentList(node, args.field)
  let next: Array<{ id: string } | Record<string, unknown>>
  if (command === 'editor.insertListItem') {
    const item = newItem(editor, field)
    validateNativeListMember(editor, node, field, item, item)
    next = [...items, item]
  } else {
    const item = items.find((current) => current.id === args.itemId)
    if (!item) throw new Error('列表条目已删除，请重新选择。')
    if (command === 'editor.deleteListItem')
      next = items.filter((current) => current.id !== item.id)
    else {
      const patch = nativeListPatch(field, args.patch)
      const before: Record<string, unknown> = { ...item }
      const changed = mergeItem(editor, field, before, patch)
      validateNativeListMember(editor, node, field, changed, patch, before)
      next = items.map((current) =>
        current.id === item.id ? changed : current,
      )
    }
  }
  editor.graph.patch.patchNode(
    node.id,
    dataPatchOf(node.type, { [field]: next }),
  )
}

/** Clears only the target node's allowed optional fields through ordinary patch history. */
function clearNativeNodeField(
  editor: EditorController,
  args: Record<string, unknown>,
): void {
  const node = currentNativeNode(editor, args)
  if (
    (args.field === 'locationId' || args.field === 'sceneNo') &&
    node.type === 'scene'
  ) {
    if (node.data[args.field] !== undefined)
      editor.graph.patch.patchNode(node.id, {
        nodeType: 'scene',
        patch: { [args.field]: undefined },
      })
  } else if (
    args.field === 'episodeNo' &&
    (node.type === 'scene' ||
      node.type === 'beat' ||
      node.type === 'dialogue' ||
      node.type === 'branch')
  )
    editor.graph.patch.patchNode(node.id, episodeNoPatch(node.type, undefined))
  else throw new Error('不允许清除此字段。')
}

/** Clear and membership actions avoid sending nulls or arrays copied from an old projection. */
export function nativeNodeExtra(
  editor: EditorController,
  command: string,
  args: Record<string, unknown>,
): boolean {
  if (
    [
      'editor.patchListItem',
      'editor.insertListItem',
      'editor.deleteListItem',
    ].includes(command)
  ) {
    listAction(editor, command, args)
    return true
  }
  if (command === 'editor.clearNodeField') {
    clearNativeNodeField(editor, args)
    return true
  }
  if (command === 'editor.toggleCharacter') {
    const node = currentNativeNode(editor, args)
    if (
      node.type !== 'scene' ||
      typeof args.characterId !== 'string' ||
      !editor.doc.settingsRef.current.characters.some(
        (c) => c.id === args.characterId,
      )
    )
      throw new Error('角色引用目标无效。')
    const ids = node.data.characterIds
    editor.graph.patch.patchNode(node.id, {
      nodeType: 'scene',
      patch: {
        characterIds: ids.includes(args.characterId)
          ? ids.filter((id) => id !== args.characterId)
          : [...ids, args.characterId],
      },
    })
    return true
  }
  return false
}

/** Image inputs have a distinct UI contract: generated outputs are deliberately not writable here. */
function nativeImagePatch(
  editor: EditorController,
  id: string,
  patch: Record<string, unknown>,
): void {
  const allowedSizes: readonly string[] = IMAGE_SIZES
  for (const [key, value] of Object.entries(patch)) {
    if (
      !['prompt', 'model', 'size'].includes(key) ||
      typeof value !== 'string' ||
      value.length > FREE_TEXT_MAX_CHARS
    )
      throw new Error('图片输入字段无效。')
    if (key === 'size' && !allowedSizes.includes(value))
      throw new Error('图片尺寸无效。')
  }
  editor.graph.patch.patchNode(id, { nodeType: 'image', patch })
}
