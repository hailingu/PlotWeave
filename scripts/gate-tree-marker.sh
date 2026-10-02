#!/bin/sh
# 门禁树标记（issues #404/#429）：记录「本次 Git 操作通过完整门禁的索引树」。
# 只有 pre-commit / pre-merge-commit 在门禁通过后 write（同操作内的
# 消费者是后触发的 prepare-commit-msg）；prepare-commit-msg 自身的回退
# 门禁通过后不写标记——同操作内没有下游消费者，写了只会让后续操作
# 复用（评审 4120239723）。revert / cherry-pick / rebase 重放等没有
# pre-commit 等价钩子的路径由 prepare-commit-msg 的回退门禁触发完整
# 门禁。标记是单次消费的：check 命中即删除，只服务产生它的那次操作，
# 后续操作（含同树 --no-verify 提交）不得复用（评审 4120128545）。标记
# 绑定调用钩子的 Git 进程 PID + 启动时间：中止操作留下的标记不能被后续
# 同树操作复用，PID 重用也必须匹配启动时间。标记仅用于去重，所有不确定
# 情形（进程身份不可解析/缺失/过期/未来时间戳/损坏/索引不可写树）一律
# 判定为需要执行门禁。
set -eu

marker_path=${PLOTWEAVE_GATE_MARKER_PATH:-$(git rev-parse --git-path plotweave-gate-tree.marker)}
ttl_seconds=${PLOTWEAVE_GATE_MARKER_TTL:-600}

# 两个兄弟钩子都由同一 Git 进程启动；调用方显式传其 PPID，不能使用
# 此助手的 PPID（那是各自不同的钩子进程）。查询失败时禁止复用标记。
operation_identity() {
  operation_pid=${2:-}
  case "$operation_pid" in '' | 0* | *[!0-9]*) return 1 ;; esac
  operation_start=$(LC_ALL=C ps -p "$operation_pid" -o lstart= 2>/dev/null) || return 1
  [ -n "$operation_start" ] || return 1
  printf '%s:%s' "$operation_pid" "$operation_start"
}

current_operation=$(operation_identity "$@") || current_operation=

# 索引树是标记的键：钩子触发时索引即本次将提交的树（含 revert /
# cherry-pick / merge 已应用的结果）。
current_tree=$(git write-tree 2>/dev/null) || current_tree=

case ${1:-} in
  write)
    # 标记是提示：写入失败不得阻塞门禁已通过的操作（下次照常执行门禁，
    # 评审 4120128565）
    if [ -n "$current_tree" ] && [ -n "$current_operation" ]; then
      printf '%s\n%s\n%s\n' "$current_tree" "$(date +%s)" "$current_operation" \
        > "$marker_path" 2>/dev/null || true
    fi
    ;;
  check)
    [ -n "$current_tree" ] || exit 1
    [ -n "$current_operation" ] || exit 1
    [ -f "$marker_path" ] || exit 1
    marked_tree=$(sed -n 1p "$marker_path" 2>/dev/null || true)
    marked_at=$(sed -n 2p "$marker_path" 2>/dev/null || true)
    marked_operation=$(sed -n 3p "$marker_path" 2>/dev/null || true)
    [ "$marked_operation" = "$current_operation" ] || exit 1
    [ "$marked_tree" = "$current_tree" ] || exit 1
    case "$marked_at" in '' | *[!0-9]*) exit 1 ;; esac
    # 年龄双侧界定：负年龄（时钟回拨后遗留的未来时间戳）与超时同样判
    # 为需门禁——任何负值都 ≤ TTL，不拒绝会让标记在整个回拨区间内保持
    # 「新鲜」（评审 4120428509）
    marker_age=$(($(date +%s) - marked_at))
    [ "$marker_age" -ge 0 ] || exit 1
    [ "$marker_age" -le "$ttl_seconds" ] || exit 1
    # 单次消费：命中即删除，防止后续操作复用（rm 失败不阻塞——标记
    # 残留只影响下次多跑一次门禁）
    rm -f "$marker_path" 2>/dev/null || true
    ;;
  *)
    printf '用法：gate-tree-marker.sh write|check <Git 进程 PID>\n' >&2
    exit 2
    ;;
esac
