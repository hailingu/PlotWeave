#!/bin/sh
# 文档专用推送检查（owner 指示 2026-10-18）：仅校验 base..head 的差异
# 不带空白错误。docs/ 没有配置代码级回归、覆盖率或 Sonar 检查，Markdown
# 被 .prettierignore 排除；本脚本只做最小、无依赖的差异卫生检查，避免
# 文档-only 推送触发全量代码门禁。
set -eu

script_directory=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
repository_root=${PLOTWEAVE_GATE_REPOSITORY_ROOT:-$(CDPATH= cd -- "$script_directory/.." && pwd)}
base=${1:-}
head=${2:-}

if [ -z "$base" ] || [ -z "$head" ]; then
  printf 'check-docs 需要 base 与 head 修订：check-docs.sh <base> <head>\n' >&2
  exit 2
fi

cd "$repository_root"
printf '[check-docs] 校验 %s..%s 的文档差异（空白/冲突标记）……\n' "$base" "$head"
git diff --check "$base" "$head" --
printf '%s\n' '[check-docs] 文档差异检查通过（未运行代码回归、覆盖率或 Sonar）。'
