import { App } from '../../App'
import { useNativeCanvasLifecycle } from './useNativeCanvasLifecycle'

/** Production canvas session mounts the existing single editor/save owner under native chrome. */
export function NativeHostApp() {
  useNativeCanvasLifecycle()
  return <App />
}
