/** Web provider edits merge into the current snapshot; encryption owns only its key intent. */
import { useRef, useState } from 'react'
import type { AppSettings, ProviderConfig } from './types'
import { settingsStore } from './settingsStore'

/** Synchronous edit state composes same-batch receipts independently for each provider. */
interface KeyIntentState {
  settings: AppSettings
  revisions: Map<string, number>
}

/** Updates the live snapshot before scheduling React so simultaneous receipts cannot lose edits. */
function patchProvider(
  state: KeyIntentState,
  update: (next: AppSettings) => void,
  id: string,
  patch: Partial<ProviderConfig>,
): void {
  const settings = state.settings
  state.settings = {
    ...settings,
    providers: settings.providers.map((provider) =>
      provider.id === id ? { ...provider, ...patch } : provider,
    ),
  }
  update(state.settings)
}

/** Superseded successes and failures are inert; valid receipts contribute only the encrypted key. */
async function encryptCurrentKey(
  state: KeyIntentState,
  update: (next: AppSettings) => void,
  id: string,
  key: string,
  revision: number,
): Promise<boolean> {
  try {
    const encrypted = await settingsStore.setProviderKey(
      state.settings,
      id,
      key,
    )
    if (state.revisions.get(id) !== revision) return false
    const keyEnc = encrypted.providers.find(
      (provider) => provider.id === id,
    )?.keyEnc
    if (typeof keyEnc !== 'string') throw new Error('密钥加密结果无效。')
    patchProvider(state, update, id, { keyEnc })
    return true
  } catch (error) {
    if (state.revisions.get(id) !== revision) return false
    throw error
  }
}

/** Owns Web key drafts/errors and invalidates encryption on a later save or clear (#850). */
export function useProviderKeyForms(
  settings: AppSettings,
  update: (next: AppSettings) => void,
  trackPendingKey: (work: Promise<void>) => Promise<void>,
) {
  const [keyDraft, setKeyDraft] = useState<Record<string, string>>({})
  const [keyError, setKeyError] = useState<Record<string, string>>({})
  const state = useRef<KeyIntentState>({
    settings,
    revisions: new Map(),
  }).current
  state.settings = settings
  const submitKey = async (id: string) => {
    const draft = keyDraft[id] ?? ''
    const key = draft.trim()
    if (!key) return
    const revision = (state.revisions.get(id) ?? 0) + 1
    state.revisions.set(id, revision)
    try {
      await trackPendingKey(
        encryptCurrentKey(state, update, id, key, revision).then((current) => {
          if (!current) return
          setKeyDraft((drafts) =>
            drafts[id] === draft ? { ...drafts, [id]: '' } : drafts,
          )
          setKeyError((errors) => ({ ...errors, [id]: '' }))
        }),
      )
    } catch (error) {
      if (state.revisions.get(id) === revision)
        setKeyError((errors) => ({ ...errors, [id]: String(error) }))
    }
  }
  const removeKey = (id: string) => {
    state.revisions.set(id, (state.revisions.get(id) ?? 0) + 1)
    patchProvider(state, update, id, { keyEnc: undefined })
    setKeyError((errors) => ({ ...errors, [id]: '' }))
  }
  return {
    keyDraft,
    setKeyDraft,
    keyError,
    patchProvider: (id: string, patch: Partial<ProviderConfig>) =>
      patchProvider(state, update, id, patch),
    submitKey,
    removeKey,
  }
}
