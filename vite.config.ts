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
      // 测试设施不计入产品覆盖率（issue #311）：与 sonar-project.properties
      // 的测试纳入清单同源——仅服务测试的模块无产品运行时形态，编译期
      // 类型探针是纯类型文件（v8 all 模式下计 0% 空条目）。
      exclude: [
        'src/**/*.test-d.ts',
        'src/moduleGraph.ts',
        'src/model/convertFixtures.ts',
        'src/editor/ai/testGraphs.ts',
        'src/styles/cssColorContract.ts',
        'src/styles/cssValueSyntax.ts',
        'src/styles/sheetTokensEngine.ts',
      ],
    },
  },
})
