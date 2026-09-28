#!/bin/sh
# 门禁树标记（issue #404）：记录「最近一次通过完整门禁的索引树」。
# 只有 pre-commit / pre-merge-commit 在门禁通过后 write（同操作内的
# 消费者是后触发的 prepare-commit-msg）；prepare-commit-msg 自身的回退
# 门禁通过后不写标记——同操作内没有下游消费者，写了只会让后续操作
# 复用（评审 4120239723）。revert / cherry-pick / rebase 重放等没有
# pre-commit 等价钩子的路径由 prepare-commit-msg 的回退门禁触发完整
# 门禁。标记是单次消费的：check 命中即删除，只服务产生它的那次操作，
# 后续操作（含同树 --no-verify 提交）不得复用（评审 4120128545）。标记
# 仅是去重提示而非信任边界：任何错配的最坏情形是对与近期刚过检完全
# 相同的树少跑一次门禁，所有不确定情形（缺失/过期/损坏/索引不可写树）
# 一律判定为需要执行门禁。
set -eu

marker_path=${PLOTWEAVE_GATE_MARKER_PATH:-$(git rev-parse --git-path plotweave-gate-tree.marker)}
ttl_seconds=${PLOTWEAVE_GATE_MARKER_TTL:-600}

# 索引树是标记的键：钩子触发时索引即本次将提交的树（含 revert /
# cherry-pick / merge 已应用的结果）。
current_tree=$(git write-tree 2>/dev/null) || current_tree=

case ${1:-} in
  write)
    # 标记是提示：写入失败不得阻塞门禁已通过的操作（下次照常执行门禁，
    # 评审 4120128565）
    if [ -n "$current_tree" ]; then
      printf '%s\n%s\n' "$current_tree" "$(date +%s)" \
        > "$marker_path" 2>/dev/null || true
    fi
    ;;
  check)
    [ -n "$current_tree" ] || exit 1
    [ -f "$marker_path" ] || exit 1
    marked_tree=$(sed -n 1p "$marker_path" 2>/dev/null || true)
    marked_at=$(sed -n 2p "$marker_path" 2>/dev/null || true)
    [ "$marked_tree" = "$current_tree" ] || exit 1
    case "$marked_at" in '' | *[!0-9]*) exit 1 ;; esac
    [ "$(($(date +%s) - marked_at))" -le "$ttl_seconds" ] || exit 1
    # 单次消费：命中即删除，防止后续操作复用（rm 失败不阻塞——标记
    # 残留只影响下次多跑一次门禁）
    rm -f "$marker_path" 2>/dev/null || true
    ;;
  *)
    printf '用法：gate-tree-marker.sh write|check\n' >&2
    exit 2
    ;;
esac
