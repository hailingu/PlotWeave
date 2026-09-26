import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { ErrorBoundary } from './ErrorBoundary'
import { installGlobalErrorGuard } from './globalErrorGuard'
import { initializeLibraryDiagnostics } from './library/libraryDiagnosticTransport'
import './index.css'

// 全局兜底最先安装（issue #358）：错误边界不捕获异步拒绝与事件处理器
// 异常，引导期失败也须留结构化诊断；监听不吞错，仅追加可见诊断。
installGlobalErrorGuard()

/* Tauri 桌面端使用 macOS Overlay 标题栏（红绿灯悬浮在内容上），
 * 根元素打上 is-tauri 标记，让应用外壳为原生控件留出安全区；
 * 纯浏览器预览时无此标记，标题栏保持正常内边距。
 * 检测用 IPC 桥 __TAURI_INTERNALS__——它在 Tauri webview 中始终存在，
 * 而 __TAURI__ 全局变量默认不注入（需 withGlobalTauri 配置）。 */
if ('__TAURI_INTERNALS__' in window) {
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
