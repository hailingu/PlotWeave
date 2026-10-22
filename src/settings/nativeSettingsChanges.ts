/** Same-page native settings invalidation contains no credentials or settings payload. */
import { isSwiftHost } from '../platform/hostEnvironment'

const SETTINGS_CHANGED = 'settings-changed'

/** Called only after the preferences IPC reports its durable save success. */
export function notifyNativeSettingsChanged(): void {
  if (isSwiftHost()) window.dispatchEvent(new Event(SETTINGS_CHANGED))
}

/** Native persistent consumers reload their own readonly snapshot and release listeners on unmount. */
export function listenNativeSettingsChanged(reload: () => void): () => void {
  if (!isSwiftHost()) return () => undefined
  window.addEventListener(SETTINGS_CHANGED, reload)
  return () => window.removeEventListener(SETTINGS_CHANGED, reload)
}
