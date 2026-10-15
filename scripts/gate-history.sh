#!/bin/sh
# 门禁结论摘要的物化（issue #355，PR #415 评审 5338815626）：门禁运行把
# 记录行追加到 .git 内的待物化文件——不在门禁运行中途留下未暂存改动，
# 重放/检出/合并不会因未暂存改动而中止。物化分三条路径：
# pre-commit / pre-merge-commit 在门禁前调用 materialize
# --stage-for-commit（issue #548）：把待物化行并入版本化文件，并在台账
# 改动可归因于门禁物化（对 HEAD 纯追加且新行均为合法 JSON 记录、无人工
# 部分暂存）时 git add 台账（含上次推送物化后遗留的未暂存行）进即将
# 创建的提交，不可归因时保留原暂存状态并警告——
# 普通提交与合并提交可靠采纳钩子暂存，服务端证据核验由此读到「滞后
# 一次提交」的账本；revert / cherry-pick / rebase 重放走的
# prepare-commit-msg 回退门禁【不】物化——sequencer 重放不采纳钩子对
# 索引的追加暂存、会留下脏工作树中止后续重放（PR #415 的保护语义保持），
# 重放记录留在待物化文件、随下一个普通提交并入；pre-push 在全部 ref
# 门禁通过后调用 materialize：并入推送尾部的记录行，保持未暂存、由
# 下一次提交路径的收编暂存或下一次变更提交。排水在与门禁同一把互斥锁下进行（评审 5339243902）：
# 记录追加只发生在门禁持锁期间，物化持同一把锁后「并入+清空」对并发追加
# 原子，完整通过的运行不会因清空窗口被无声丢弃。等锁超时或配置非数字只
# 警告并保留待物化行待下次物化。物化尽力而为：失败只警告、不阻塞已通过
# 的门禁或提交/推送；并入成功而清空失败至多造成重复行，日志语义下无害。

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

node_bin=${PLOTWEAVE_NODE_BIN:-node}

# 台账改动的归因判定（PR #581 评审 5537676738）：自动暂存只收编可归因
# 于门禁物化的内容，判定用钉版 Node 对比四个输入：HEAD 版、有效索引版、
# 工作树版与本次折并的待物化行。两种可归因形态：
# ① 本次折并的行恰为索引之上的纯追加（每行可解析为 JSON）——用户已
#   暂存的台账选择被逐字保留，暂存只追加工具写入的行；
# ② 工作树是 HEAD 版的逐行纯追加、追加行逐一可解析为 JSON、且索引要么
#   与 HEAD 一致（无人工暂存）要么与工作树一致（人工已全量暂存）——
#   覆盖推送尾物化遗留行的收编；索引处于其他形态说明开发者做了部分
#   暂存，不得覆盖。
# 任何无法判定（Node 不可用/崩溃、非 Git 环境）都视为不可归因，宁可退回
# 人工暂存；判定输出 attributed。
ledger_change_attribution() {
  ledger_directory=$(CDPATH= cd -- "$(dirname -- "$history_path")" && pwd) || return 1
  ledger_name=$(basename -- "$history_path")
  head_temp=$(mktemp) || return 1
  index_temp=$(mktemp) || return 1
  git -C "$ledger_directory" show "HEAD:./$ledger_name" >"$head_temp" 2>/dev/null || : >"$head_temp"
  git -C "$ledger_directory" show ":./$ledger_name" >"$index_temp" 2>/dev/null || : >"$index_temp"
  verdict=$("$node_bin" - "$head_temp" "$index_temp" "$history_path" "${folded_capture:-}" <<'ATTRIBUTION'
const { readFileSync } = require('node:fs')
const read = (path) => {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return ''
  }
}
const toLines = (text) => {
  const lines = text.split('\n')
  if (lines[lines.length - 1] === '') lines.pop()
  return lines
}
const head = toLines(read(process.argv[2]))
const index = toLines(read(process.argv[3]))
const work = toLines(read(process.argv[4]))
const folded = toLines(read(process.argv[5]))
const same = (left, right) =>
  left.length === right.length && left.every((line, position) => line === right[position])
const parseable = (lines) =>
  lines.every((line) => {
    try {
      JSON.parse(line)
      return true
    } catch {
      return false
    }
  })
const foldAppend =
  folded.length > 0 && same(work, index.concat(folded)) && parseable(folded)
const headAppend =
  head.every((line, position) => work[position] === line) &&
  parseable(work.slice(head.length)) &&
  (same(index, head) || same(index, work))
if (foldAppend || headAppend) {
  process.stdout.write('attributed')
}
ATTRIBUTION
  ) || verdict=
  rm -f "$head_temp" "$index_temp" "${folded_capture:-}"
  printf '%s' "$verdict"
}

# 提交创建路径的暂存（issue #548）：把版本化台账 git add 进即将创建的
# 提交——含刚并入的待物化行与上次推送物化后遗留的未暂存行（AGENTS.md
# 「随下一次变更一起提交」的规范由此自动执行）。只在普通提交与合并提交
# 钩子（pre-commit / pre-merge-commit）调用：这些路径的暂存可靠进入提交
# 且不留未暂存残留（PR #415 评审 5338815626 的中止形态是未暂存写）；
# sequencer 重放不采纳追加暂存，prepare-commit-msg 回退路径不得调用。
# 台账文件不存在时静默跳过；台账与 HEAD 无差异且本次未并入新行时静默
# 跳过；改动不可归因于门禁物化（修改/删除既有行、畸形新行、人工部分
# 暂存、无法判定）时保留原暂存状态并警告 [GATE_HISTORY_UNATTRIBUTED_
# CHANGE]，交回开发者人工核验；git add 失败只警告
# [GATE_HISTORY_STAGE_FAILED]。三者都绝不阻塞已通过的门禁或本次提交。
folded_this_run=
folded_capture=
stage_materialized_lines() {
  if [ ! -f "$history_path" ]; then
    return 0
  fi
  if [ "$folded_this_run" != 1 ] &&
    git diff --quiet HEAD -- "$history_path" 2>/dev/null &&
    git diff --cached --quiet HEAD -- "$history_path" 2>/dev/null; then
    return 0
  fi
  if [ "$(ledger_change_attribution)" != 'attributed' ]; then
    printf 'gate-history 警告：[GATE_HISTORY_UNATTRIBUTED_CHANGE] 台账 %s 存在不可归因于门禁物化的改动（修改/删除既有行、畸形新行、人工部分暂存）或无法完成归因判定；保留原暂存状态，请人工核验后随下一次变更提交；不阻塞本次操作。\n' \
      "$history_path" >&2
    return 0
  fi
  if git add -- "$history_path" 2>/dev/null; then
    printf '[gate-history] 已暂存物化记录，随本提交入库。\n'
  else
    printf 'gate-history 警告：[GATE_HISTORY_STAGE_FAILED] 无法暂存 %s（当前目录不在 Git 仓库内或路径不可加入索引）；记录保持未暂存、随下一次变更提交；不阻塞本次操作。\n' \
      "$history_path" >&2
  fi
}

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
    stage_for_commit=
    if [ "${2:-}" = '--stage-for-commit' ]; then
      stage_for_commit=1
    elif [ -n "${2:-}" ]; then
      printf '用法：gate-history.sh materialize [--stage-for-commit]\n' >&2
      exit 2
    fi
    if [ ! -s "$pending_path" ] && [ -z "$stage_for_commit" ]; then
      exit 0
    fi
    if [ ! -s "$pending_path" ]; then
      # 无待物化行：仅提交路径的收编暂存（如推送物化后的遗留行），不排水
      stage_materialized_lines
      exit 0
    fi
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
    folded_capture=$(mktemp) || folded_capture=
    if [ -n "$folded_capture" ]; then
      cp "$pending_path" "$folded_capture" 2>/dev/null || folded_capture=
    fi
    if cat "$pending_path" >> "$history_path" 2>/dev/null &&
      : > "$pending_path" 2>/dev/null; then
      folded_this_run=1
      printf '[gate-history] %s 行门禁结论已物化到 %s。\n' \
        "$pending_lines" "$history_path"
      if [ -n "$stage_for_commit" ]; then
        stage_materialized_lines
      fi
    else
      printf 'gate-history 警告：无法物化门禁记录（%s → %s）；不阻塞推送。\n' \
        "$pending_path" "$history_path" >&2
    fi
    ;;
  *)
    printf '用法：gate-history.sh materialize [--stage-for-commit]\n' >&2
    exit 2
    ;;
esac
