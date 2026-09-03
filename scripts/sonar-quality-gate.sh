#!/bin/sh
# 为本地提交与推送生成最新覆盖率，并强制 SonarQube Quality Gate 通过且未解决问题为零。

set -eu

script_directory=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
repository_root=$(CDPATH= cd -- "$script_directory/.." && pwd)

npm_bin=${PLOTWEAVE_NPM_BIN:-npm}
scanner_bin=${PLOTWEAVE_SONAR_SCANNER_BIN:-sonar-scanner}
curl_bin=${PLOTWEAVE_CURL_BIN:-curl}
node_bin=${PLOTWEAVE_NODE_BIN:-node}
coverage_report_path=${PLOTWEAVE_COVERAGE_REPORT_PATH:-$repository_root/coverage/lcov.info}
lock_directory=${PLOTWEAVE_SONAR_LOCK_DIRECTORY:-$repository_root/.sonar-gate.lock}
report_path=${PLOTWEAVE_SONAR_REPORT_PATH:-$repository_root/.scannerwork/report-task.txt}
quality_gate_timeout=${SONAR_QUALITY_GATE_TIMEOUT:-300}
sonar_host_url=${SONAR_HOST_URL:-}
# 认证令牌：SONAR_TOKEN 优先；未设时回退到 PLOTWEAVE_SONAR_TOKEN
#（可在 ~/.zshrc 等 shell 配置里导出，Git 钩子继承调用方环境）。
sonar_token=${SONAR_TOKEN:-${PLOTWEAVE_SONAR_TOKEN:-}}

cd "$repository_root"

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

mkdir "$lock_directory" 2>/dev/null ||
  fail '另一个 SonarQube 门禁正在运行；为保护共享覆盖率与扫描目录，本次操作已停止'
trap release_lock 0 1 2 15

printf '%s\n' '[SonarQube] 生成最新前端覆盖率……'
"$npm_bin" run test:coverage

[ -s "$coverage_report_path" ] ||
  fail "覆盖率报告缺失或为空：$coverage_report_path"
grep -q '^SF:' "$coverage_report_path" ||
  fail "覆盖率报告没有任何源文件记录：$coverage_report_path"
grep -Eq '^DA:[0-9]+,[1-9][0-9]*' "$coverage_report_path" ||
  fail "覆盖率报告没有任何已覆盖代码行：$coverage_report_path"

printf '%s\n' '[SonarQube] 扫描并等待 Quality Gate……'
"$scanner_bin" \
  "-Dsonar.host.url=$sonar_host_url" \
  "-Dsonar.javascript.lcov.reportPaths=$coverage_report_path" \
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

issues_json=$(sonar_api \
  --get "$server_url/api/issues/search" \
  --data-urlencode "componentKeys=$project_key" \
  --data-urlencode 'resolved=false' \
  --data-urlencode 'ps=1')
unresolved_issues=$(printf '%s' "$issues_json" | "$node_bin" -e '
  const input = require("node:fs").readFileSync(0, "utf8");
  const total = JSON.parse(input)?.total;
  if (!Number.isInteger(total) || total < 0) {
    process.stderr.write("SonarQube Issues 响应缺少有效 total\n");
    process.exit(1);
  }
  process.stdout.write(String(total));
')

[ "$unresolved_issues" -eq 0 ] ||
  fail "仍有 $unresolved_issues 个未解决问题；修复后重新运行，禁止绕过"

printf '%s\n' '[SonarQube] Quality Gate 已通过，未解决问题为 0。'
