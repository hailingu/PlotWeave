import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { ErrorBoundary } from './ErrorBoundary'
import { isTauriRuntime } from './ipc/runtime'
import { initializeLibraryDiagnostics } from './library/libraryDiagnosticTransport'
import './index.css'

/* Tauri 桌面端使用 macOS Overlay 标题栏（红绿灯悬浮在内容上），
 * 根元素打上 is-tauri 标记，让应用外壳为原生控件留出安全区；
 * 纯浏览器预览时无此标记，标题栏保持正常内边距。 */
if (isTauriRuntime()) {
  document.documentElement.classList.add('is-tauri')
}

// 先建立恢复事件监听，再让组件发起库媒体/导入请求，消除启动丢诊断窗口。
void initializeLibraryDiagnostics().then((unlisten) => {
  if (unlisten) window.addEventListener('pagehide', unlisten, { once: true })
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <ErrorBoundary>
        <App />
      </ErrorBoundary>
    </StrictMode>,
  )
})
