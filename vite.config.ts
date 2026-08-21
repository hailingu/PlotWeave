import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Tauri 开发模式要求固定的 devUrl，因此锁定端口并禁止端口回退。
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 5173,
    strictPort: true,
  },
})
