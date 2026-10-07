/** Validates native row deltas without treating retained document fields as new AI input. */
import type { EditorController } from '../useEditorController'
import type { CanvasNode } from '../nodes/types'
import { plainObject } from '../ai/patchShape'

/** Native list fields are owned by dialogue, branch and shot nodes respectively. */
export type NativeListField = 'lines' | 'options' | 'refs'

/** Accepted delta keys exclude stable identities and unknown passthrough document fields. */
const PATCH_KEYS: Record<NativeListField, readonly string[]> = {
  lines: ['kind', 'text', 'speaker', 'side', 'vo'],
  options: ['label'],
  refs: ['kind', 'assetId', 'label'],
}

/** Rejects malformed row patches before merging, including ambiguous reference/free-slot writes. */
export function nativeListPatch(
  field: NativeListField,
  raw: unknown,
): Record<string, unknown> {
  if (!plainObject(raw)) throw new Error('列表补丁无效。')
  if ('id' in raw) throw new Error('不能修改条目身份。')
  if (Object.keys(raw).some((key) => !PATCH_KEYS[field].includes(key)))
    throw new Error('列表补丁含未知字段。')
  if (field === 'refs' && 'assetId' in raw && 'label' in raw)
    throw new Error('资产引用与自由文案不能同时写入。')
  return raw
}

/** Builds a known dialogue candidate using only the newly written fields and kind-transition defaults. */
function dialogueCandidate(
  before: Record<string, unknown> | undefined,
  next: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const candidate: Record<string, unknown> = {
    id: next.id,
    kind: next.kind,
    text: 'text' in patch ? patch.text : '',
  }
  for (const field of ['side', 'vo']) {
    if (field in patch) candidate[field] = patch[field]
  }
  if ('speaker' in patch) {
    if (patch.speaker !== null) candidate.speaker = patch.speaker
  } else if (next.kind !== before?.kind && next.speaker !== undefined)
    candidate.speaker = next.speaker
  return candidate
}

/** Validates changed bindings against live assets; an unchanged old binding stays outside the candidate. */
function referenceCandidate(
  before: Record<string, unknown> | undefined,
  next: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const candidate: Record<string, unknown> = { id: next.id, kind: next.kind }
  if ('label' in patch) candidate.label = patch.label
  else if (
    'assetId' in patch ||
    (next.kind !== before?.kind && 'assetId' in next)
  ) {
    candidate.assetId = next.assetId
    if ('label' in next) candidate.label = next.label
  } else candidate.label = ''
  return candidate
}

/** Checks one inserted or modified member through the existing domain validator, without applying its normalized replacement. */
export function validateNativeListMember(
  editor: EditorController,
  node: CanvasNode,
  field: NativeListField,
  next: Record<string, unknown>,
  patch: Record<string, unknown>,
  before?: Record<string, unknown>,
): void {
  let candidate: Record<string, unknown> = {
    id: next.id,
    label: 'label' in patch ? patch.label : '',
  }
  if (field === 'lines') candidate = dialogueCandidate(before, next, patch)
  else if (field === 'refs') candidate = referenceCandidate(before, next, patch)
  const result = editor.ai.validateCommands([
    { op: 'update_node', nodeId: node.id, patch: { [field]: [candidate] } },
  ])
  if (!result?.ok || result.commands[0]?.op !== 'update_node')
    throw new Error(
      result?.issues.map((issue) => issue.message).join('；') ||
        '列表字段无效。',
    )
}
