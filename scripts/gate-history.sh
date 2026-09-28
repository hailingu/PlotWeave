#!/bin/sh
# 门禁结论摘要的物化（issue #355，PR #415 评审 5338815626）：门禁运行把
# 记录行追加到 .git 内的待物化文件——提交创建路径绝不改动被跟踪的
# docs/development/gate-history.jsonl，重放/检出/合并不会因未暂存改动而
# 中止。pre-push 在门禁通过后调用 materialize：把待物化行并入版本化文件
# 并清空待物化文件。排水在与门禁同一把互斥锁下进行（评审 5339243902）：
# 记录追加只发生在门禁持锁期间，物化持同一把锁后「并入+清空」对并发追加
# 原子，完整通过的运行不会因清空窗口被无声丢弃。等锁超时或配置非数字只
# 警告并保留待物化行待下次推送。物化尽力而为：失败只警告、不阻塞推送；
# 并入成功而清空失败至多造成下次推送重复行，日志语义下无害。

set -eu

script_directory=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
repository_root=$(CDPATH= cd -- "$script_directory/.." && pwd)

history_path=${PLOTWEAVE_GATE_HISTORY_PATH:-$repository_root/docs/development/gate-history.jsonl}
lock_directory=${PLOTWEAVE_SONAR_LOCK_DIRECTORY:-$repository_root/.sonar-gate.lock}
materialize_lock_timeout=${PLOTWEAVE_GATE_MATERIALIZE_LOCK_TIMEOUT:-300}

cd "$repository_root"

# 待物化路径在 cd 之后解析：git-path 的输出相对当前目录，须在仓库根下
# 取值；非仓库环境回退到仓库根下的 .git。
pending_path=${PLOTWEAVE_GATE_PENDING_PATH:-$(git rev-parse --git-path plotweave-gate-history.pending 2>/dev/null || printf '%s' "$repository_root/.git/plotweave-gate-history.pending")}

# 释放当前物化持有的互斥目录（与门禁同一把锁、同一释放方式）。
release_lock() {
  rmdir "$lock_directory" 2>/dev/null || true
}

# 等待并获取与门禁相同的互斥锁（评审 5339243902）：秒级轮询 mkdir，
# 超时返回非零——调用方据此跳过物化（待物化行保留，下次推送重试），
# 物化绝不因等锁而阻塞或失败推送。
wait_for_gate_lock() {
  waited=0
  while :; do
    if mkdir "$lock_directory" 2>/dev/null; then
      return 0
    fi
    if [ "$waited" -ge "$materialize_lock_timeout" ]; then
      return 1
    fi
    sleep 1
    waited=$((waited + 1))
  done
}

case ${1:-} in
  materialize)
    [ -s "$pending_path" ] || exit 0
    case "$materialize_lock_timeout" in
      '' | *[!0-9]*)
        printf 'gate-history 警告：物化锁等待超时配置非数字（%s），跳过物化；不阻塞推送。\n' \
          "$materialize_lock_timeout" >&2
        exit 0
        ;;
    esac
    if ! wait_for_gate_lock; then
      printf 'gate-history 警告：物化等待门禁锁超时（%s 秒），待物化行保留至下次推送；不阻塞推送。\n' \
        "$materialize_lock_timeout" >&2
      exit 0
    fi
    trap release_lock 0 1 2 15
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
