#!/bin/sh
# 门禁结论摘要的物化（issue #355，PR #415 评审 5338815626；issue #548）：
# 门禁运行把记录行追加到 .git 内的待物化文件——不在门禁运行中途留下
# 未暂存改动，重放/检出/合并不会因未暂存改动而中止。物化路径：
# pre-commit / pre-merge-commit 在门禁前调用 materialize
# --stage-for-commit（issue #548）：把待物化行并入版本化文件，且仅在
# 工作树台账恰为「索引内容 + 本次并入的待物化行」（字节精确匹配、每行
# 合法 JSON）时 git add 进即将创建的提交——归因以待物化文件保存的确切
# 内容为凭（PR #581 评审 5537970549）：开发者已暂存的台账选择被逐字
# 保留，任何其他未暂存改动（人工合法追加、修改/删除既有行、污染行）
# 一律警告 [GATE_HISTORY_UNATTRIBUTED_CHANGE] 并保留原暂存状态；
# revert / cherry-pick / rebase 重放走的 prepare-commit-msg 回退门禁
# 【不】物化——sequencer 重放不采纳钩子对索引的追加暂存、会留下脏工作
# 树中止后续重放（PR #415 的保护语义保持），重放记录留在待物化文件、
# 随下一个普通提交并入；pre-push 自 PR #581 评审 5537970549 起【不】
# 物化：推送不触碰被跟踪台账，工作树保持干净（快路径的台账失效来源
# 随之消失），推送产生的记录留在待物化文件、同样由下一次提交折并暂
# 存。git commit -- <pathspec> / --only 使用临时索引（PR #581 评审
# 5543397069）：此时【整体推迟】——不折并也不暂存（折并的 git add 只
# 会写进临时索引，真实索引残留旧版、下个普通提交还会把记录反向提交
# 掉），待物化记录原样保留、由下一个普通提交折并暂存。裸 materialize
# 仅作人工排水出口（并入后保持未暂存）。排水在与
# 门禁同一把互斥锁下进行（评审 5339243902）：记录追加只发生在门禁持
# 锁期间，物化持同一把锁后「并入+清空」对并发追加原子，完整通过的
# 运行不会因清空窗口被无声丢弃。等锁超时或配置非数字只警告并保留待
# 物化行待下次物化。物化尽力而为：失败只警告、不阻塞已通过的门禁或
# 提交/推送；并入成功而清空失败至多造成重复行，日志语义下无害。

set -eu

script_directory=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
repository_root=$(CDPATH= cd -- "$script_directory/.." && pwd)

history_path=${PLOTWEAVE_GATE_HISTORY_PATH:-$repository_root/docs/development/gate-history.jsonl}
materialize_lock_timeout=${PLOTWEAVE_GATE_MATERIALIZE_LOCK_TIMEOUT:-300}
node_bin=${PLOTWEAVE_NODE_BIN:-node}

cd "$repository_root"

# #917 owner decision: linked worktrees share durable pending bytes and the same mutex.
# Git returns an absolute common directory; standalone/non-Git fixtures keep their local fallback.
shared_git_directory=$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null || printf '%s' "$repository_root/.git")
pending_path=${PLOTWEAVE_GATE_PENDING_PATH:-$shared_git_directory/plotweave-gate-history.pending}
lock_directory=${PLOTWEAVE_SONAR_LOCK_DIRECTORY:-$shared_git_directory/plotweave-sonar-gate.lock}

# 归因读取的 Git 环境（issue #829）：链接 worktree（git worktree add）的提交
# 钩子导出绝对 GIT_DIR（.git/worktrees/<name>），显式 GIT_DIR 使 Git 把当前目
# 录当作工作树根，":./<台账>" 与 "HEAD:./<台账>" 被解析成根级路径——两条读取
# 都 exit 128，归因落入空索引分支：字节匹配场景必然判为不可归因，已暂存删除
# 场景反而误判 attributed、把折并重建的台账暂存回去替换删除。主 worktree 的
# 钩子不导出 GIT_DIR、本就按台账目录自动发现仓库；这里把两种形态统一为同一
# 语义：只在归因读取上清除 GIT_DIR，让 Git 从台账目录发现 worktree 根。
# GIT_INDEX_FILE 原样保留——它仍指向钩子选定的索引（链接 worktree 为绝对路径，
# 主 worktree 为相对路径且由 Git 按工作树根解析）。
ledger_git() {
  env -u GIT_DIR git -C "$ledger_directory" "$@"
}

# 台账改动的归因判定（PR #581 评审 5537970549）：自动暂存只收编本次
# 折并的待物化行本身。判定用钉版 Node 对比三个输入：有效索引版、工作
# 树版与本次折并的待物化行；工作树原始字节必须恰为「索引字节 + 本次
# 折并字节」（开发者已暂存选择被逐字保留），仅折并内容另做逐行 JSON
# 校验。不得归一化 EOF 换行，否则会收编开发者的未暂存换行改动
# （PR #581 评审 5544334841）。任何其他字节差异——人工合法 JSON 追加、
# 修改/删除既有行、污染前缀——都使归因失败。任何无法判定（Node 不可用/崩溃、非 Git 环
# 境读不到索引）都视为不可归因，宁可退回人工暂存；判定输出 attributed，
# 索引中无该路径而 HEAD 中存在时输出 staged-deletion（PR #581 评审
# 5542467935：那是开发者已暂存的台账删除，不得把重建的台账自动暂存回去
# 替换删除；两者皆无才是台账引导态，按空索引继续判定）。
ledger_change_attribution() {
  ledger_directory=$(CDPATH= cd -- "$(dirname -- "$history_path")" && pwd) || return 1
  ledger_name=$(basename -- "$history_path")
  index_temp=$(mktemp) || return 1
  if ! ledger_git show ":./$ledger_name" >"$index_temp" 2>/dev/null; then
    if ledger_git cat-file -e "HEAD:./$ledger_name" 2>/dev/null; then
      rm -f "$index_temp"
      printf 'staged-deletion'
      return 0
    fi
    : >"$index_temp"
  fi
  verdict=$("$node_bin" - "$index_temp" "$history_path" "${folded_capture:-}" <<'ATTRIBUTION'
const { readFileSync } = require('node:fs')
const read = (path) => path ? readFileSync(path) : Buffer.alloc(0)
const toLines = (text) => {
  const lines = text.split('\n')
  if (lines[lines.length - 1] === '') lines.pop()
  return lines
}
const index = read(process.argv[2])
const work = read(process.argv[3])
const folded = read(process.argv[4])
const parseable = toLines(folded.toString('utf8')).every((line) => {
  try {
    JSON.parse(line)
    return true
  } catch {
    return false
  }
})
if (parseable && work.equals(Buffer.concat([index, folded]))) {
  process.stdout.write('attributed')
}
ATTRIBUTION
  ) || verdict=
  rm -f "$index_temp"
  printf '%s' "$verdict"
}

# 提交创建路径的暂存（issue #548）：把版本化台账 git add 进即将创建的
# 提交——仅归因判定通过（见上）时执行；判定为 staged-deletion（已暂存
# 的台账删除）时警告 [GATE_HISTORY_STAGED_DELETION] 并保留删除、不把
# 折并重建的台账暂存回去（PR #581 评审 5542467935）；其余不可归因情形
# 保留原暂存状态并警告 [GATE_HISTORY_UNATTRIBUTED_CHANGE]；git add 失
# 败只警告 [GATE_HISTORY_STAGE_FAILED]。只在普通提交与合并提交钩子
# （pre-commit / pre-merge-commit）调用：这些路径的暂存可靠进入提交且
# 不留未暂存残留（PR #415 评审 5338815626 的中止形态是未暂存写）；
# sequencer 重放不采纳追加暂存，prepare-commit-msg 回退路径不得调用。
# 台账文件不存在、或台账与 HEAD 无差异且本次未并入新行时静默跳过；
# 各分支都绝不阻塞已通过的门禁或本次提交。
# 临时索引检测（PR #581 评审 5543397069）：git commit -- <pathspec> /
# --only 为提交构建临时索引（GIT_INDEX_FILE 指向非真实索引及其锁文件）；此时任何
# git add 只写临时索引——真实索引残留旧版、下个普通提交会把已物化的
# 记录从台账反向提交掉。检测为真时整体推迟：不折并、不暂存，待物化
# 记录原样保留给下一个普通提交。非提交环境（无 .git）按无临时索引处理。
commit_uses_temporary_index() {
  [ -n "${GIT_INDEX_FILE:-}" ] || return 1
  # 普通提交的钩子环境里 GIT_INDEX_FILE 也被设置（常为相对路径
  # 「.git/index」）；-a / --amend -a 使用 Git 会采纳的 index.lock，
  # 同样允许折并暂存。两侧都以 repository_root 前缀归一为同一逻辑路径后
  # 比较——不用 --absolute-git-dir（macOS 上 /tmp→/private/tmp 的符号
  # 链接会让物理路径与逻辑路径前缀不一致而误判）——只有真正指向别的
  # 索引（pathspec 的 next-index-*.lock 等）才判为临时索引
  git_dir=$(git rev-parse --git-dir 2>/dev/null) || return 1
  case $git_dir in
    /*) real_index=$git_dir/index ;;
    *) real_index=$repository_root/$git_dir/index ;;
  esac
  case $GIT_INDEX_FILE in
    /*) given_index=$GIT_INDEX_FILE ;;
    *) given_index=$repository_root/$GIT_INDEX_FILE ;;
  esac
  [ "$given_index" != "$real_index" ] && [ "$given_index" != "$real_index.lock" ]
}

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
  attribution=$(ledger_change_attribution)
  case $attribution in
    attributed)
      ;;
    staged-deletion)
      printf 'gate-history 警告：[GATE_HISTORY_STAGED_DELETION] 台账 %s 的删除已被暂存：本次折并只重建了工作树文件，不自动暂存以替换该删除；请人工核验（如确需删除，请同时清理待物化记录后人工提交）；不阻塞本次操作。\n' \
        "$history_path" >&2
      return 0
      ;;
    *)
      printf 'gate-history 警告：[GATE_HISTORY_UNATTRIBUTED_CHANGE] 台账 %s 存在不可归因于门禁物化的改动（工作树多出本次折并之外的内容：人工追加、修改/删除既有行或污染行）或无法完成归因判定；保留原暂存状态，请人工核验后随下一次变更提交；不阻塞本次操作。\n' \
        "$history_path" >&2
      return 0
      ;;
  esac
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
# 超时返回非零——调用方据此跳过物化（待物化行保留，下次物化重试），
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

# 排水前要求工作树台账位于记录边界（PR #581 评审 5544522794）：
# 未终止末行时只警告并保留全部输入，开发者补换行并暂存后可重试。
# 引导态（无文件）及空文件可写入首条记录；读取失败不能当成边界通过。
ledger_boundary_is_ready() {
  boundary_verdict=$("$node_bin" - "$history_path" <<'BOUNDARY'
const { readFileSync } = require('node:fs')
try {
  const content = readFileSync(process.argv[2])
  process.stdout.write(content.length === 0 || content.at(-1) === 10 ? 'ready' : 'unterminated')
} catch (error) {
  if (error.code === 'ENOENT') process.stdout.write('ready')
  else process.exit(1)
}
BOUNDARY
  ) || boundary_verdict=
  case $boundary_verdict in
    ready) return 0 ;;
    unterminated)
      printf 'gate-history 警告：[GATE_HISTORY_UNTERMINATED_LEDGER] 台账末行没有终止换行；本次不折并、不清空待物化记录。请补换行并暂存台账后重试；不阻塞本次操作。\n' >&2
      ;;
    *)
      printf 'gate-history 警告：[GATE_HISTORY_BOUNDARY_UNAVAILABLE] 无法物化：不能检查台账记录边界；保留台账与待物化记录供下次重试，不阻塞本次操作。\n' >&2
      ;;
  esac
  return 1
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
    if [ -n "$stage_for_commit" ] && commit_uses_temporary_index; then
      printf '[gate-history] 检测到临时索引（git commit -- <pathspec> / --only）：本次不折并不暂存，%s 行待物化记录保留至下一个普通提交；不阻塞本次提交。\n'         "$(grep -c '' "$pending_path" 2>/dev/null || printf 0)"
      exit 0
    fi
    if [ ! -s "$pending_path" ]; then
      # 无待物化行：仅提交路径的归因判定（有未归因改动时警告），不排水
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
      printf 'gate-history 警告：[GATE_HISTORY_LOCK_TIMEOUT] 物化等待门禁锁超时（%s 秒），待物化行保留至下次物化；不阻塞推送。\n' \
        "$materialize_lock_timeout" >&2
      exit 0
    fi
    trap release_lock 0 1 2 15
    if ! ledger_boundary_is_ready; then
      exit 0
    fi
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
        rm -f "$folded_capture" 2>/dev/null || :
        folded_capture=
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
