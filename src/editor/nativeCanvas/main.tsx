import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { NativeCanvasApp } from './NativeCanvasApp'
import { NativeHostApp } from './NativeHostApp'
import { ErrorBoundary } from '../../ErrorBoundary'
import { initializeLibraryDiagnostics } from '../../library/libraryDiagnosticTransport'
// 生产入口与隔离夹具共用 React Flow 的画布定位、端口和连线基础样式。
import '@xyflow/react/dist/style.css'
import '../../index.css'

/** Production uses real project services; only the explicit fixture fragment selects the memory demo. */
const fixture = window.location.hash === '#fixture'
void initializeLibraryDiagnostics().then((unlisten) => {
  if (unlisten) window.addEventListener('pagehide', unlisten, { once: true })
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <ErrorBoundary>
        {fixture ? <NativeCanvasApp /> : <NativeHostApp />}
      </ErrorBoundary>
    </StrictMode>,
  )
})
