import { configDefaults, defineConfig } from 'vitest/config'
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
    // 内嵌 git worktree（.worktrees/**）是独立检出：其测试以各自目录为
    // 基准运行（PostCSS from 等路径相对 CWD 解析，从父仓库根跑其测试会
    // 误判令牌源归属），不应被父仓库的测试发现扫描（.worktrees 出现于
    // issue #362 评审期间，排除对主仓测试集无影响）。
    exclude: [...configDefaults.exclude, '.worktrees/**'],
    // lcov 供 SonarQube（sonar.javascript.lcov.reportPaths）；text 供本地直观核对
    coverage: {
      provider: 'v8',
      reporter: ['lcov', 'text'],
      // 覆盖率下限（issue #393）：整体行覆盖率 ≥ 80%，跌破即本命令非零
      // 退出。数值与本机 SonarQube 服务端 Quality Gate 的 80% 行覆盖率条件
      // 对齐（服务端条件不在版本控制内，这是仓库侧可失败的等价下限），
      // 不追踪实测基线（98.13%，见 typescript-standard.md「Coverage Floor
      // And Baseline」），差额留作余量。口径为行覆盖率——与门禁台账
      // frontendLineCoveragePercent 同一 LCOV DA 口径，sonar-quality-gate.sh
      // 在扫描前按同一口径复核两份报告；分支等其余口径不设下限（Rust 侧
      // 无分支口径，见 rust-standard.md「测试覆盖率」）。恰等于下限通过。
      // 数值契约由 scripts/sonar-test-scope.test.ts 守卫。
      thresholds: { lines: 80 },
      include: ['src/**'],
      // 测试设施不计入产品覆盖率（issue #311，issue #343 补录
      // sheetRuleQuery 并由 scripts/sonar-test-scope.test.ts 同源核验）：
      // 与 sonar-project.properties 的测试纳入清单同源——仅服务测试的
      // 模块无产品运行时形态，编译期类型探针是纯类型文件（v8 all 模式下
      // 计 0% 空条目）。
      exclude: [
        'src/**/*.test-d.ts',
        'src/moduleGraph.ts',
        'src/model/convertFixtures.ts',
        'src/editor/ai/testGraphs.ts',
        'src/styles/cssColorContract.ts',
        'src/styles/cssValueSyntax.ts',
        'src/styles/sheetRuleQuery.ts',
        'src/styles/sheetTokensEngine.ts',
      ],
    },
  },
})
