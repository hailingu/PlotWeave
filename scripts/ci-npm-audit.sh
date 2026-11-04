#!/bin/sh
# CI 的 npm 依赖审计入口（issue #741 方案 A；#552/#618 的阻断语义不变）。
# `npm audit --audit-level=high` 单次执行时，registry 审计端点的瞬时网络故
# 障（超时、5xx、连接被拒、DNS 失败）会让 frontend 必需检查随机失败并阻断
# 合并（2026-10-22 03:08–03:19 UTC 窗口内 #707/#710/#713 连续命中）。本脚
# 本把「审计未能执行」与「审计已得出结论」分开处置：
# - 退出 0：无 high/critical 发现，立即通过。
# - 非 0 且输出含 npm 的审计执行失败诊断 `audit endpoint returned an error`
#   （观测到的全部网络类失败——超时、5xx、ECONNREFUSED、DNS——都以这一行
#   收尾，而真实漏洞报告绝不含它）：有限次指数退避重试；重试耗尽仍阻断
#   （fail-closed，#618 语义不弱化）。
# - 非 0 且不含该诊断：审计已得出结论（存在 high/critical 漏洞，或其他确
#   定性错误），按 npm 原退出码立即阻断，不重试。
# npm 若在未来版本改动该文案，本脚本退化为「不重试、立即阻断」——只会更
# 严，不会放行。可调参数面向测试与运维：PLOTWEAVE_AUDIT_MAX_ATTEMPTS（总
# 尝试次数，默认 4 = 3 次重试）、PLOTWEAVE_AUDIT_RETRY_BASE_SECONDS（首次
# 等待秒数，默认 30，逐次翻倍：30/60/120）。npm 自身的抓取超时保持默认，
# 故最坏情况约为 4 次各 ~5 分钟的超时加 210 秒退避。
# 诊断码：[NPM_AUDIT_RETRY] 重试通告；[NPM_AUDIT_EXHAUSTED] 重试耗尽阻断；
# [NPM_AUDIT_CONFIG] 参数非法（退出 2，不执行审计）。前缀为 GitHub Actions
# 工作流命令，使重试与阻断在 PR 检查页以注解形式可见。

set -eu

max_attempts=${PLOTWEAVE_AUDIT_MAX_ATTEMPTS:-4}
retry_delay=${PLOTWEAVE_AUDIT_RETRY_BASE_SECONDS:-30}
execution_failure_marker='audit endpoint returned an error'

# 仅接受十进制非负整数，拒绝空值、符号与小数——参数错误必须显式失败。
is_non_negative_integer() {
  case $1 in
    '' | *[!0-9]*) return 1 ;;
    *) return 0 ;;
  esac
}

if ! is_non_negative_integer "$max_attempts" || [ "$max_attempts" -lt 1 ]; then
  echo "::error::[NPM_AUDIT_CONFIG] PLOTWEAVE_AUDIT_MAX_ATTEMPTS must be a positive integer (got: $max_attempts)" >&2
  exit 2
fi
if ! is_non_negative_integer "$retry_delay"; then
  echo "::error::[NPM_AUDIT_CONFIG] PLOTWEAVE_AUDIT_RETRY_BASE_SECONDS must be a non-negative integer (got: $retry_delay)" >&2
  exit 2
fi

attempt=1
while :; do
  status=0
  output=$(npm audit --audit-level=high 2>&1) || status=$?
  printf '%s\n' "$output"
  if [ "$status" -eq 0 ]; then
    exit 0
  fi
  if ! printf '%s\n' "$output" | grep -q -- "$execution_failure_marker"; then
    exit "$status"
  fi
  if [ "$attempt" -ge "$max_attempts" ]; then
    echo "::error::[NPM_AUDIT_EXHAUSTED] npm audit could not execute after $max_attempts attempt(s); failing closed (issues #618/#741)" >&2
    exit 1
  fi
  echo "::warning::[NPM_AUDIT_RETRY] npm audit attempt $attempt/$max_attempts could not reach the advisory endpoint; retrying in ${retry_delay}s (issue #741)"
  sleep "$retry_delay"
  attempt=$((attempt + 1))
  retry_delay=$((retry_delay * 2))
done
