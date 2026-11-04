/** npm prepare 生命周期自动接线版本化 Git 钩子（issue #725）：非 CI 的 Git 检出在依赖安装后即完成 core.hooksPath 配置；跳过与失败均以稳定诊断码提示且不阻断 npm install。 */
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url))

/** 在仓库根执行 git；返回退出码（spawn 失败为 null），失败路径由调用方分类。 */
function git(args) {
  return spawnSync('git', args, { cwd: repositoryRoot, encoding: 'utf8' })
}

if (process.env.CI) {
  // 托管 CI 不经本地钩子创建提交；跳过使 npm ci 与接线前行为一致。
  console.log('[HOOKS_INSTALL_SKIPPED] CI 环境跳过 Git 钩子接线')
} else if (git(['rev-parse', '--git-dir']).status !== 0) {
  console.log('[HOOKS_INSTALL_SKIPPED] 非 Git 检出，跳过 Git 钩子接线')
} else if (git(['config', 'core.hooksPath', '.githooks']).status !== 0) {
  // 接线失败不得中断依赖安装；缺席以显式诊断暴露而非静默（issue #725）。
  console.error(
    '[HOOKS_INSTALL_FAILED] Git 钩子接线失败，请手动运行 npm run hooks:install（git config core.hooksPath .githooks）',
  )
} else {
  console.log('[HOOKS_INSTALLED] Git 钩子已接线：core.hooksPath=.githooks')
}
