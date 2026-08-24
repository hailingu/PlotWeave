import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './index.css'

/* Tauri 桌面端使用 macOS Overlay 标题栏（红绿灯悬浮在内容上），
 * 根元素打上 is-tauri 标记，让应用外壳为原生控件留出安全区；
 * 纯浏览器预览时无此标记，标题栏保持正常内边距。 */
if ('__TAURI__' in window) {
  document.documentElement.classList.add('is-tauri')
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
