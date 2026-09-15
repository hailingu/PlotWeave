import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import NativeCanvasApp from './NativeCanvasApp'
// 独立入口不加载 EditorView，必须自行引入画布定位、端口和连线基础样式。
import '@xyflow/react/dist/style.css'
import '../index.css'

/**
 * 原生外壳画布演示页入口（P1 视觉首片）：独立于主应用入口，仅供
 * vite.native-canvas.config.ts 构建到 native/macos/App/WebCanvas，由
 * WKWebView 经 file:// 加载；无 Tauri 桥、无持久化（详见
 * src/native-canvas/ 内各模块注释）。
 */
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <NativeCanvasApp />
  </StrictMode>,
)
