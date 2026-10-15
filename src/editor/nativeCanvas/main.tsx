import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { NativeCanvasApp } from './NativeCanvasApp'
import { NativeHostApp } from './NativeHostApp'
import { ErrorBoundary } from '../../ErrorBoundary'
import { initializeLibraryDiagnostics } from '../../library/libraryDiagnosticTransport'
import { canvasPerfFixture, parseCanvasPerfHash } from './canvasPerfFixture'
import { installCanvasPerfScriptRunner } from './canvasPerfScript'
// 生产入口与隔离夹具共用 React Flow 的画布定位、端口和连线基础样式。
import '@xyflow/react/dist/style.css'
import '../../index.css'

/** Production uses real project services; only the explicit fixture fragment selects the memory demo. */
const fixture = window.location.hash === '#fixture'
/** M15 验证页（#perf:N）装配固定规模夹具与宿主脚本入口（issue #523）。 */
const perfScale = fixture ? null : parseCanvasPerfHash(window.location.hash)
if (perfScale !== null) installCanvasPerfScriptRunner()
void initializeLibraryDiagnostics().then((unlisten) => {
  if (unlisten) window.addEventListener('pagehide', unlisten, { once: true })
  let page = <NativeHostApp />
  if (fixture) {
    page = <NativeCanvasApp />
  } else if (perfScale !== null) {
    page = <NativeCanvasApp graph={canvasPerfFixture(perfScale)} />
  }
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <ErrorBoundary>{page}</ErrorBoundary>
    </StrictMode>,
  )
})
