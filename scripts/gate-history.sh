#!/bin/sh
# 门禁结论摘要的物化（issue #355，PR #415 评审 5338815626）：门禁运行把
# 记录行追加到 .git 内的待物化文件——提交创建路径绝不改动被跟踪的
# docs/development/gate-history.jsonl，重放/检出/合并不会因未暂存改动而
# 中止。pre-push 在门禁通过后调用 materialize：把待物化行并入版本化文件
# 并清空待物化文件。物化尽力而为：失败只警告、不阻塞推送；并入成功而
# 清空失败至多造成下次推送出现重复行，日志语义下无害。

set -eu

script_directory=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
repository_root=$(CDPATH= cd -- "$script_directory/.." && pwd)

history_path=${PLOTWEAVE_GATE_HISTORY_PATH:-$repository_root/docs/development/gate-history.jsonl}

cd "$repository_root"

# 待物化路径在 cd 之后解析：git-path 的输出相对当前目录，须在仓库根下
# 取值；非仓库环境回退到仓库根下的 .git。
pending_path=${PLOTWEAVE_GATE_PENDING_PATH:-$(git rev-parse --git-path plotweave-gate-history.pending 2>/dev/null || printf '%s' "$repository_root/.git/plotweave-gate-history.pending")}

case ${1:-} in
  materialize)
    [ -s "$pending_path" ] || exit 0
    pending_lines=$(grep -c '' "$pending_path" 2>/dev/null) || pending_lines=0
    if cat "$pending_path" >> "$history_path" 2>/dev/null &&
      : > "$pending_path" 2>/dev/null; then
      printf '[gate-history] %s 行门禁结论已物化到 %s。\n' \
        "$pending_lines" "$history_path"
    else
      printf 'gate-history 警告：无法物化门禁记录（%s → %s）；不阻塞推送。\n' \
        "$pending_path" "$history_path" >&2
    fi
    ;;
  *)
    printf '用法：gate-history.sh materialize\n' >&2
    exit 2
    ;;
esac
