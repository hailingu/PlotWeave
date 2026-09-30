#!/bin/sh
# 为本地提交与推送生成最新覆盖率，并强制 SonarQube Quality Gate 通过且新增代码
# 未解决问题为零（增量清零：sinceLeakPeriod 过滤 New Code 周期内的问题；全项目
# 历史问题另行治理，不阻塞提交）。

set -eu

script_directory=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
# 门禁根覆盖（issue #405）：pre-push 慢路径把根指向临时 worktree——执行的
# 仍是当前工作树的脚本副本，分析对象换成被推提交的检出树（依赖安装、
# 覆盖率与扫描都在该树下进行）。属测试/钩子注入点，与 PLOTWEAVE_*_BIN
# 同类（见 docs/development/quality-gate-cost.md）。
repository_root=${PLOTWEAVE_GATE_REPOSITORY_ROOT:-$(CDPATH= cd -- "$script_directory/.." && pwd)}

npm_bin=${PLOTWEAVE_NPM_BIN:-npm}
scanner_bin=${PLOTWEAVE_SONAR_SCANNER_BIN:-sonar-scanner}
curl_bin=${PLOTWEAVE_CURL_BIN:-curl}
node_bin=${PLOTWEAVE_NODE_BIN:-node}
coverage_report_path=${PLOTWEAVE_COVERAGE_REPORT_PATH:-$repository_root/coverage/lcov.info}
rust_coverage_report_path=${PLOTWEAVE_RUST_COVERAGE_REPORT_PATH:-$repository_root/src-tauri/target/coverage/lcov-rust.info}
llvm_cov_bin=${PLOTWEAVE_CARGO_LLVM_COV_BIN:-cargo-llvm-cov}
lock_directory=${PLOTWEAVE_SONAR_LOCK_DIRECTORY:-$repository_root/.sonar-gate.lock}
report_path=${PLOTWEAVE_SONAR_REPORT_PATH:-$repository_root/.scannerwork/report-task.txt}
quality_gate_timeout=${SONAR_QUALITY_GATE_TIMEOUT:-300}
sonar_host_url=${SONAR_HOST_URL:-}
# 认证令牌：SONAR_TOKEN 优先；未设时回退到 PLOTWEAVE_SONAR_TOKEN
#（可在 ~/.zshrc 等 shell 配置里导出，Git 钩子继承调用方环境）。
sonar_token=${SONAR_TOKEN:-${PLOTWEAVE_SONAR_TOKEN:-}}

cd "$repository_root"

# 待物化路径在 cd 之后解析（PR #415 评审 5338815626）：git-path 的输出
# 相对当前目录，须在仓库根下取值；非仓库环境回退到仓库根下的 .git。
gate_pending_path=${PLOTWEAVE_GATE_PENDING_PATH:-$(git rev-parse --git-path plotweave-gate-history.pending 2>/dev/null || printf '%s' "$repository_root/.git/plotweave-gate-history.pending")}

# 输出一致的阻塞原因并终止当前 Git 操作。
fail() {
  printf 'SonarQube 门禁失败：%s\n' "$1" >&2
  exit 1
}

# 确保门禁所需的本地命令可执行。
require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "缺少命令：$1"
}

# 从本次扫描生成的 report-task.txt 中读取指定属性。
read_report_value() {
  awk -F= -v key="$1" '$1 == key { sub(/^[^=]*=/, ""); print; exit }' "$report_path"
}

# 从 LCOV 报告计算行覆盖率百分比：DA 记录按执行次数 > 0 计为已覆盖。
# 报告在调用前已通过非空与已覆盖校验；awk 异常时按 0 兜底，不让摘要
# 计算失败外溢为门禁失败。
lcov_line_coverage_percent() {
  awk -F, '
    BEGIN { covered = 0; total = 0 }
    /^DA:/ { total += 1; if ($2 + 0 > 0) covered += 1 }
    END { printf "%.2f", (total > 0 ? 100 * covered / total : 0) }
  ' "$1" 2>/dev/null || printf '0'
}

# 覆盖率下限（issue #393）：整体行覆盖率 ≥ 80%——与本机 SonarQube 服务端
# Quality Gate 的 80% 条件对齐的仓库侧可失败下限，不依赖服务端条件存在
# 或未被改动；按与门禁台账相同的 LCOV DA 口径在扫描前复核两份报告。
# 数值不追踪实测基线（Rust 82.6%/前端 98.13%，见 rust-standard.md 与
# typescript-standard.md），差额留作余量。恰等于下限通过（与服务端
# 「低于才失败」语义一致）；达标不得靠扩充排除清单（scripts/
# sonar-test-scope.test.ts 双向核验）。前端另有 vitest thresholds
#（vite.config.ts）在 npm run test:coverage 内先行失败。
coverage_floor_percent=80
enforce_line_coverage_floor() {
  # 比较用未取整的命中/总数整数交叉相乘（covered×100 ≥ total×floor）：
  # 79.998% 类真值若先经 %.2f 取整成 80.00 再比较会被误放行，而 Rust 无
  # 前端侧 Vitest 阈值的独立第二层（PR #422 评审 5347340194）。取整
  # 百分比只出现在失败消息与台账（后者由 lcov_line_coverage_percent
  # 独立计算，语义不变）。
  verdict=$(awk -F, -v floor="$coverage_floor_percent" '
    BEGIN { covered = 0; total = 0 }
    /^DA:/ { total += 1; if ($2 + 0 > 0) covered += 1 }
    END {
      if (total > 0 && covered * 100 >= total * floor) {
        print "pass"
      } else {
        printf "fail %d/%d（取整 %.2f%%）\n", covered, total, \
          (total > 0 ? 100 * covered / total : 0)
      }
    }
  ' "$2" 2>/dev/null) || verdict=''
  case $verdict in
    pass) return 0 ;;
    fail\ *)
      fail "$1行覆盖率 ${verdict#fail } 低于仓库下限 ${coverage_floor_percent}%（issue #393）"
      ;;
    *)
      fail "无法复核 $1行覆盖率下限：$2"
      ;;
  esac
}

# 门禁结论摘要记录（issue #355）：完整通过后把关键结论——UTC 时间、被检
# 索引树（与 gate-tree-marker 同键）、运行时 HEAD、Quality Gate 状态、新
# 增代码未解决问题数、前端与 Rust 行覆盖率——追加为 .git 内待物化文件的
# 一行 JSON。只记结论：令牌与原始扫描产物均不入库。提交创建路径绝不直
# 接改动被跟踪的版本化 gate-history.jsonl（PR #415 评审 5338815626：那样
# 会给重放/检出/合并留下未暂存改动而中止操作）；待物化行由 pre-push 门禁
# 通过后的 scripts/gate-history.sh materialize 并入版本化文件。写入尽力而
# 为：任一步失败只向标准错误警告、不阻塞已通过的门禁（与树标记同哲学）。
append_gate_history_record() {
  gate_tree=$(git write-tree 2>/dev/null) || gate_tree=
  gate_head=$(git rev-parse HEAD 2>/dev/null) || gate_head=
  frontend_percent=$(lcov_line_coverage_percent "$coverage_report_path")
  rust_percent=$(lcov_line_coverage_percent "$rust_coverage_report_path")
  if printf '{"timestamp":"%s","tree":"%s","head":"%s","qualityGate":"%s","newCodeUnresolvedIssues":%s,"frontendLineCoveragePercent":%s,"rustLineCoveragePercent":%s}\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    "$gate_tree" \
    "$gate_head" \
    "$quality_gate_status" \
    "$new_issues" \
    "$frontend_percent" \
    "$rust_percent" \
    >> "$gate_pending_path" 2>/dev/null; then
    printf '[SonarQube] 门禁结论已记录，待推送时并入版本化 gate-history.jsonl。\n'
  else
    printf 'SonarQube 警告：无法写入门禁记录 %s；本次结论未入库，不阻塞已通过的操作。\n' \
      "$gate_pending_path" >&2
  fi
}

# 调用 SonarQube API；令牌只通过 curl 标准输入传入，避免出现在参数或日志中。
sonar_api() {
  if [ -n "$sonar_token" ]; then
    printf 'header = "Authorization: Bearer %s"\n' "$sonar_token" |
      "$curl_bin" --config - --silent --show-error --fail-with-body "$@"
  else
    "$curl_bin" --silent --show-error --fail-with-body "$@"
  fi
}

# 释放当前门禁持有的互斥目录，避免正常退出留下死锁。
release_lock() {
  rmdir "$lock_directory" 2>/dev/null || true
}

[ -n "$sonar_host_url" ] ||
  fail '必须显式设置 SONAR_HOST_URL，避免扫描器误连 SonarQube Cloud'

# 令牌校验与下发：字符集限制先于任何使用；扫描器只认 SONAR_TOKEN /
# sonar.token 属性，在此把解析结果（含 PLOTWEAVE_SONAR_TOKEN 回退）统一
# 导出为环境变量——令牌不进命令行参数、不进进程列表与日志。
if [ -n "$sonar_token" ]; then
  case "$sonar_token" in
    *[!A-Za-z0-9._~-]*) fail 'SONAR_TOKEN/PLOTWEAVE_SONAR_TOKEN 含有不支持的字符' ;;
  esac
  SONAR_TOKEN=$sonar_token
  export SONAR_TOKEN
fi

require_command "$npm_bin"
require_command "$scanner_bin"
require_command "$curl_bin"
require_command "$node_bin"
require_command "$llvm_cov_bin"

mkdir "$lock_directory" 2>/dev/null ||
  fail '另一个 SonarQube 门禁正在运行；为保护共享覆盖率与扫描目录，本次操作已停止'
trap release_lock 0 1 2 15

printf '%s\n' '[SonarQube] 生成最新前端覆盖率……'
# 静态检查先行（issue #227）：格式 + lint 零警告——fail-fast 在覆盖率与
# 扫描之前；与手动检查同一入口（scripts/check-static.sh），不分叉
printf '%s\n' '[SonarQube] 静态检查（格式 + lint 零警告）……'
"$script_directory/check-static.sh"

"$npm_bin" run test:coverage

[ -s "$coverage_report_path" ] ||
  fail "覆盖率报告缺失或为空：$coverage_report_path"
grep -q '^SF:' "$coverage_report_path" ||
  fail "覆盖率报告没有任何源文件记录：$coverage_report_path"
grep -Eq '^DA:[0-9]+,[1-9][0-9]*' "$coverage_report_path" ||
  fail "覆盖率报告没有任何已覆盖代码行：$coverage_report_path"

# 前端行覆盖率下限（issue #393）：fail-fast 在 Rust 覆盖率生成与扫描之前
enforce_line_coverage_floor '前端' "$coverage_report_path"

# Rust 覆盖率（issue #169）：经 rust-coverage.sh 生成并校验（非空、有
# 源文件记录、有已覆盖行），与前端 LCOV 一并导入质量报告——「存在 Rust
# 测试」不等于「已度量覆盖率」，未度量与未覆盖由此可区分。
printf '%s\n' '[SonarQube] 生成最新 Rust 覆盖率……'
"$script_directory/rust-coverage.sh"

# Rust 行覆盖率下限（issue #393）：与前端同一口径，扫描发布前复核
enforce_line_coverage_floor 'Rust' "$rust_coverage_report_path"

printf '%s\n' '[SonarQube] 扫描并等待 Quality Gate……'
"$scanner_bin" \
  "-Dsonar.host.url=$sonar_host_url" \
  "-Dsonar.javascript.lcov.reportPaths=$coverage_report_path" \
  "-Dsonar.rust.lcov.reportPaths=$rust_coverage_report_path" \
  -Dsonar.qualitygate.wait=true \
  "-Dsonar.qualitygate.timeout=$quality_gate_timeout"

[ -f "$report_path" ] || fail "扫描完成后未生成 $report_path"

project_key=$(read_report_value projectKey)
server_url=$(read_report_value serverUrl)
[ -n "$project_key" ] || fail 'report-task.txt 缺少 projectKey'
[ -n "$server_url" ] || fail 'report-task.txt 缺少 serverUrl'
case "$server_url" in
  http://* | https://*) ;;
  *) fail "report-task.txt 的 serverUrl 不是 HTTP(S) 地址：$server_url" ;;
esac

quality_gate_json=$(sonar_api \
  --get "$server_url/api/qualitygates/project_status" \
  --data-urlencode "projectKey=$project_key")
quality_gate_status=$(printf '%s' "$quality_gate_json" | "$node_bin" -e '
  const input = require("node:fs").readFileSync(0, "utf8");
  const status = JSON.parse(input)?.projectStatus?.status;
  if (typeof status !== "string") {
    process.stderr.write("SonarQube Quality Gate 响应缺少状态\n");
    process.exit(1);
  }
  process.stdout.write(status);
')

[ "$quality_gate_status" = 'OK' ] || fail "Quality Gate 状态为 $quality_gate_status"

# 增量清零：sinceLeakPeriod=true 只统计 New Code 周期内的未解决问题——
# 提交/推送只对本改动引入的问题负责，存量历史问题不再阻塞 Git 操作。
issues_json=$(sonar_api \
  --get "$server_url/api/issues/search" \
  --data-urlencode "componentKeys=$project_key" \
  --data-urlencode 'resolved=false' \
  --data-urlencode 'sinceLeakPeriod=true' \
  --data-urlencode 'ps=1')
new_issues=$(printf '%s' "$issues_json" | "$node_bin" -e '
  const input = require("node:fs").readFileSync(0, "utf8");
  const total = JSON.parse(input)?.total;
  if (!Number.isInteger(total) || total < 0) {
    process.stderr.write("SonarQube Issues 响应缺少有效 total\n");
    process.exit(1);
  }
  process.stdout.write(String(total));
')

[ "$new_issues" -eq 0 ] ||
  fail "新增代码仍有 $new_issues 个未解决问题；修复后重新运行，禁止绕过"

append_gate_history_record

printf '%s\n' '[SonarQube] Quality Gate 已通过，新增代码未解决问题为 0。'
