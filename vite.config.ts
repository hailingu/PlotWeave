import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

// Tauri 开发模式要求固定的 devUrl，因此锁定端口并禁止端口回退。
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 5173,
    strictPort: true,
  },
  test: {
    // lcov 供 SonarQube（sonar.javascript.lcov.reportPaths）；text 供本地直观核对
    coverage: {
      provider: 'v8',
      reporter: ['lcov', 'text'],
      include: ['src/**'],
    },
  },
})
