import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'

/**
 * 本地文件入口使用经典 defer 脚本与普通样式表：WKWebView 的 file://
 * 页面无法执行 Vite 默认带 CORS 的模块入口。仅处理本配置生成的标签；
 * IIFE 与关闭代码分割保证产物不再需要浏览器的 ES module 加载器。
 */
function fileCanvasEntry(): Plugin {
  return {
    name: 'file-canvas-entry',
    apply: 'build',
    transformIndexHtml: {
      order: 'post',
      handler: (html) =>
        html
          .replace(/(<script\b[^>]*?)\s+type="module"/g, '$1 defer')
          .replace(/(<(?:script|link)\b[^>]*?)\s+crossorigin\b/g, '$1'),
    },
  }
}

/**
 * 原生 Web 画布入口的独立构建：生产页面装配 App，显式 hash 选择隔离
 * 演示/性能夹具。单入口 native-canvas.html、相对 base（WKWebView 经
 * file:// 加载，绝对路径资源不可达）、扁平产物名（Xcode 文件夹同步成员
 * 打平进 app bundle，无 assets/ 子目录）。输出目录
 * native/macos/App/WebCanvas 为一次性构建产物（gitignore），构建命令见
 * package.json 的 build:native-canvas 脚本；主应用构建（vite.config.ts）
 * 不受影响。PLOTWEAVE_CANVAS_PROFILE=1 显式启用生产 Profiler；
 * 只替换 React DOM client renderer；React 19 profiling 依赖根 react-dom
 * 的共享内部状态，根入口必须保持原样，避免循环引用并保证 flushSync 一致。
 */
export default defineConfig(() => ({
  plugins: [react(), fileCanvasEntry()],
  resolve: {
    alias:
      process.env.PLOTWEAVE_CANVAS_PROFILE === '1'
        ? [
            {
              find: /^react-dom\/client$/,
              replacement: 'react-dom/profiling',
            },
          ]
        : [],
  },
  base: './',
  /* 演示页无 favicon 等公共资源需求，避免把 public/ 复制进 app bundle */
  publicDir: false,
  build: {
    outDir: 'native/macos/App/WebCanvas',
    emptyOutDir: true,
    modulePreload: false,
    cssCodeSplit: false,
    rolldownOptions: {
      input: 'native-canvas.html',
      output: {
        format: 'iife',
        codeSplitting: false,
        /* 单一脚本入口保持稳定名，样式资源带哈希；全部平铺，
         * 适配 Xcode 文件夹同步成员的资源打平。 */
        entryFileNames: '[name].js',
        assetFileNames: '[name]-[hash][extname]',
      },
    },
  },
}))
