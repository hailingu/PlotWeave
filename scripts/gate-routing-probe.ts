/** 为真实 Git 钩子的路由测试提供门禁边界探针；完整流水线另由集成用例执行。 */
import { chmodSync, writeFileSync } from 'node:fs'

/** 记录实际分析根中的 Git 树与 HEAD，受控失败，不模拟流水线内部检查。 */
export function writeGateRoutingProbe(path: string): void {
  writeFileSync(
    path,
    `#!/bin/sh
exec "$PLOTWEAVE_NODE_BIN" - <<'PROBE'
const { appendFileSync } = require('node:fs')
const { execFileSync } = require('node:child_process')
const env = process.env
const root = env.PLOTWEAVE_GATE_REPOSITORY_ROOT
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()
const tree = git('write-tree')
const head = git('rev-parse', 'HEAD')
const untracked = git('ls-files', '--others', '--exclude-standard', 'tests', 'fixtures', 'docs')
appendFileSync(env.PLOTWEAVE_TEST_LOG, 'gate-probe\\nanalyzed-tree ' + tree + '\\nuntracked-input ' + untracked + '\\n')
if (env.PLOTWEAVE_TEST_QUALITY_GATE_STATUS !== 'OK') process.exit(1)
appendFileSync(env.PLOTWEAVE_GATE_PENDING_PATH, JSON.stringify({
  tree, head, qualityGate: 'OK', newCodeUnresolvedIssues: 0,
}) + '\\n')
PROBE
`,
  )
  chmodSync(path, 0o755)
}
