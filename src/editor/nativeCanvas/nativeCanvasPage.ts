import type { ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { initializeLibraryDiagnostics } from '../../library/libraryDiagnosticTransport'
import { invalidateHandleQueries } from '../nodes/handleQueryCache'
import { createDiagnostic } from '../../diagnostics'

/** 失败事件显式绑定级别、域与机器码；旧前缀和上下文原样交付。 */
const logEvents = {
  pwCanvasInitializationFailed: createDiagnostic(
    'ERROR',
    'plotweave::frontend::canvas',
    'PW_CANVAS_INITIALIZATION_FAILED',
  ),
  pwCanvasDisposeFailed: createDiagnostic(
    'ERROR',
    'plotweave::frontend::canvas',
    'PW_CANVAS_DISPOSE_FAILED',
  ),
}

/** Own one document's React root and asynchronous diagnostics until permanent navigation. */
export function mountNativeCanvasPage(
  container: HTMLElement,
  page: ReactNode,
): void {
  let root: Root | null = null
  let stopDiagnostics: (() => void) | undefined
  let disposed = false

  /** Clear ownership before callbacks so duplicate exits and late initialization cannot revive it. */
  function dispose(): void {
    if (disposed) return
    disposed = true
    window.removeEventListener('pagehide', onPageHide)
    const currentRoot = root
    const currentStop = stopDiagnostics
    root = null
    stopDiagnostics = undefined
    attemptCleanup(() => currentStop?.())
    if (currentRoot) attemptCleanup(() => unmountCanvas(container, currentRoot))
  }

  /** A cached document keeps its tree; the native bridge owns its separate session policy. */
  function onPageHide(event: PageTransitionEvent): void {
    if (!event.persisted) dispose()
  }

  window.addEventListener('pagehide', onPageHide)
  void initialize()

  /** Acquire diagnostics before rendering, releasing a late subscription without mounting a page. */
  async function initialize(): Promise<void> {
    try {
      const unlisten = await initializeLibraryDiagnostics()
      if (disposed) {
        attemptCleanup(() => unlisten?.())
        return
      }
      stopDiagnostics = unlisten
      root = createRoot(container)
      root.render(page)
    } catch (error) {
      dispose()
      logEvents.pwCanvasInitializationFailed('[Canvas] 页面初始化失败', {
        code: 'PW_CANVAS_INITIALIZATION_FAILED',
        error,
      })
    }
  }
}

/** Release selector caches around React cleanup, including queries against newly detached nodes. */
function unmountCanvas(container: HTMLElement, root: Root): void {
  const handles = Array.from(
    container.getElementsByClassName('react-flow__handle'),
  )
  invalidateHandleQueries(handles)
  try {
    root.unmount()
  } finally {
    invalidateHandleQueries(handles)
  }
}

/** A failed external unsubscriber must not prevent the remaining page resources from releasing. */
function attemptCleanup(cleanup: () => void): void {
  try {
    cleanup()
  } catch (error) {
    logEvents.pwCanvasDisposeFailed('[Canvas] 页面清理失败', {
      code: 'PW_CANVAS_DISPOSE_FAILED',
      error,
    })
  }
}
