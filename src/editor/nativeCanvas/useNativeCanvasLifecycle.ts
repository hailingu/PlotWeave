import { useEffect } from 'react'
import {
  notifyCanvasHostReady,
  readInitialHostAppearance,
  setHostAppearanceHandler,
  type HostAppearance,
} from './canvasHostBridge'

/** Applies the native host's appearance semantics without changing system-browser defaults. */
function applyHostAppearance(appearance: HostAppearance): void {
  const root = document.documentElement
  root.dataset.hostColorScheme = appearance.colorScheme
  root.dataset.hostReduceTransparency = String(appearance.reduceTransparency)
  root.dataset.hostIncreaseContrast = String(appearance.increaseContrast)
  root.dataset.hostReduceMotion = String(appearance.reduceMotion)
}

/** Shared production/fixture page handshake and appearance subscription; mounting never saves data. */
export function useNativeCanvasLifecycle(): void {
  useEffect(() => {
    const frame = requestAnimationFrame(() => notifyCanvasHostReady())
    return () => cancelAnimationFrame(frame)
  }, [])
  useEffect(() => {
    const initial = readInitialHostAppearance()
    if (initial) applyHostAppearance(initial)
    setHostAppearanceHandler(applyHostAppearance)
    return () => setHostAppearanceHandler(null)
  }, [])
}
