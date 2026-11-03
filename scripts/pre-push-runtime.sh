# POSIX single-commit execution helpers for pre-push (#948).
# The entry hook owns initialization and traps; sourced functions share that one lifecycle.

# 剥离 git 向提交类钩子导出的工作树定位变量（GIT_INDEX_FILE / GIT_PREFIX
# 等按 cwd 相对解析：临时 worktree 里 .git 是文件，.git/index 不是合法
# 路径，worktree add / remove / 门禁会误失败）。真实暴露路径是提交门禁
# 内运行本仓库测试套件——套件继承钩子环境后在其沙箱里真实 git push
# 触发本钩子（issue #405）。
unset_git_localization() {
  unset GIT_INDEX_FILE GIT_PREFIX GIT_WORK_TREE GIT_DIR ||
    : # unset 为内建，仅防御性兜底
}
# 移除登记的临时 worktree 与其临时根并置空登记，使重复清理（信号 trap
# 之后的退出 trap）幂等：目标已不存在同样视为成功——残留警告只在目录
# 确实留存时出现（issue #465：信号路径曾对已清理干净的目标重试 remove
# 并误报「无法清理」）。移除失败时保留现场供 git worktree prune 恢复。
remove_temporary_worktree() {
  target_worktree=$temp_worktree
  target_root=$temp_root
  temp_worktree=
  temp_root=
  [ -n "$target_worktree" ] || return 0
  if ( unset_git_localization
    git worktree remove --force "$target_worktree" ) 2>/dev/null ||
    [ ! -e "$target_worktree" ]; then
    rm -rf "$target_root" 2>/dev/null || :
  else
    printf 'pre-push 警告：[PRE_PUSH_WORKTREE_RESIDUE] 无法清理临时 worktree %s；可用 git worktree prune 清理。\n' \
      "$target_worktree" >&2
  fi
}
cleanup_temporary_artifacts() {
  remove_temporary_worktree
  if [ -n "$scope_manifest_path" ]; then
    rm -f "$scope_manifest_path" 2>/dev/null || :
    scope_manifest_path=
  fi
  if [ -n "$manifest_path" ]; then
    rm -f "$manifest_path" 2>/dev/null || :
    manifest_path=
  fi
}
# 信号路径（issue #465；PR #484 评审 5389125859）：POSIX 语义下前台子进程
# 运行期间的信号 trap 会被推迟到该子进程返回（专项审计实测单独向钩子发
# SIGINT 后 18 分钟 npm ci 仍在运行）；改为后台作业 + 可被信号打断的 wait
# 后，这里能及时执行。先向受监督进程组发 TERM，随后等待组长（安装执行器
# 或门禁脚本，锁的持有者）自行退出——组长存活期间绝不升级 KILL：那会在
# 门禁的 release_lock trap 运行前杀死它、泄漏锁目录。门禁脚本的长步骤
# 以可中断 wait 运行、信号先释放锁再退出，安装执行器有既有的限期自清理，
# 均应秒级退出。组长退出后清扫仍存活的组员；宽限期（10 秒）后组长仍存活
# 时保留其运行并如实提示，锁由其退出时释放。以 128+信号 码退出，Git 按
# 钩子失败处理本次操作（推送中止，门禁结论不产出）。
handle_termination_signal() {
  signal_exit_code=$1
  if [ -n "$supervised_group_pid" ]; then
    leader_pid=$supervised_group_pid
    kill -TERM -- "-$leader_pid" 2>/dev/null ||
      kill -TERM "$leader_pid" 2>/dev/null || :
    grace_attempts=0
    while [ "$grace_attempts" -lt 10 ] &&
      kill -0 "$leader_pid" 2>/dev/null; do
      sleep 1
      grace_attempts=$((grace_attempts + 1))
    done
    if kill -0 "$leader_pid" 2>/dev/null; then
      printf '[PRE_PUSH_LEFTOVER_GROUP] 受监督子进程（组 %s）未在宽限期内退出，已停止强制终止以免在锁释放前杀死门禁；其退出前门禁锁 %s 保持占用。\n' \
        "$leader_pid" "$lock_directory" >&2
    else
      kill -KILL -- "-$leader_pid" 2>/dev/null || :
    fi
    supervised_group_pid=
  fi
  printf '[PRE_PUSH_INTERRUPTED] 收到终止信号，已终止门禁子进程；正在清理临时资源。\n' >&2
  exit "$signal_exit_code"
}

# Emit the existing stable failure and stop the owning hook.
fail() {
  printf 'pre-push 失败：%s\n' "$1" >&2
  exit 1
}

# 受监督运行（issue #465）：分钟级子进程（安装执行器与门禁脚本）以后台
# 作业 + wait 运行——wait 可被信号打断，钩子的信号 trap 得以及时执行
# （前台子进程会把 trap 推迟到其返回）。启用作业控制仅为让该后台作业
# 获得独立进程组，信号路径得以向整组（含后代）发 TERM/KILL；真实
# Ctrl-C 场景下终端信号仍直达钩子本身，分工不变。wait 的 stderr 重定向
# 吸收 shell 对被杀作业的状态通告。参数为要异步执行的函数名。
supervise_child_process() {
  set -m
  "$@" </dev/null &
  supervised_group_pid=$!
  set +m
  if wait "$supervised_group_pid" 2>/dev/null; then
    supervised_group_pid=
    return 0
  fi
  supervised_group_pid=
  return 1
}

# 快路径前提（issue #405）：工作树内容与 HEAD 一致（含索引，保证台账
# tree 键与被推提交同源），且整个仓库没有未忽略未跟踪文件：Vitest
# 可发现任意目录内的测试，测试导入的辅助文件和夹具也可能改写覆盖率，
# 不能按固定目录或测试后缀证明输入等价。已知残余（记录于
# quality-gate-cost.md）：被忽略文件与
# skip-worktree/assume-unchanged 隐藏的差异对 git 不可见，快路径无法
# 证明其不存在；慢路径的全新检出不受影响。前提不成立时把首个失败项记入
# fast_path_block_code / fast_path_block_detail（issue #463），供分派处
# 输出慢路径触发原因；代码契约见 quality-gate-push.md。
working_tree_represents_head() {
  fast_path_block_code=
  fast_path_block_detail=
  if ! git diff --quiet HEAD --; then
    fast_path_block_code=PRE_PUSH_SLOW_TRACKED_DIRTY
    fast_path_block_detail='工作树被跟踪内容与 HEAD 有差异'
    return 1
  fi
  if ! git diff --cached --quiet HEAD --; then
    fast_path_block_code=PRE_PUSH_SLOW_INDEX_DIRTY
    fast_path_block_detail='索引内容与 HEAD 有差异'
    return 1
  fi
  if ! untracked_files=$(git ls-files --others --exclude-standard); then
    fast_path_block_code=PRE_PUSH_SLOW_UNTRACKED_ENUM_FAILED
    fast_path_block_detail='无法枚举未跟踪文件'
    return 1
  fi
  if [ -n "$untracked_files" ]; then
    fast_path_block_code=PRE_PUSH_SLOW_UNTRACKED_INPUT
    fast_path_block_detail='仓库内存在未忽略的未跟踪文件'
    return 1
  fi
}

# 慢路径：临时 worktree 检出被推提交，按该树锁文件安装依赖，再以当前
# 门禁脚本在该树上执行完整门禁（分析对象 = 被推提交，门禁定义 = 当前
# 工作树版本）。安装与门禁均经 supervise_child_process 受监督运行，
# 中断信号能及时终止它们并清理临时树（issue #465）。
gate_commit_in_temp_worktree() {
  commit=$1
  short=$(git rev-parse --short "$commit")
  temp_root=$(mktemp -d "${TMPDIR:-/tmp}/plotweave-pre-push.XXXXXXXX")
  temp_worktree=$temp_root/worktree
  ( unset_git_localization
    git worktree add --quiet --detach "$temp_worktree" "$commit" ) ||
    fail "无法在临时 worktree 检出被推提交 $short"
  supervise_child_process run_install_for_pushed_tree ||
    fail "被推树 $short 的依赖安装失败（npm ci；树内缺 package-lock.json 亦会走到这里）"
  supervise_child_process run_gate_for_pushed_tree
  remove_temporary_worktree
}

# 慢路径安装入口（异步子壳内执行，exec 使受监督 pid 即执行器本身）：
# 当前执行器清理两个 Sonar 令牌变量，并以期限监督 npm 及 lifecycle 子
# 进程组（issue #462）。
run_install_for_pushed_tree() {
  cd "$temp_worktree" && unset_git_localization &&
    PLOTWEAVE_NPM_BIN=$npm_bin \
      exec "$node_bin" "$main_root/scripts/pre-push-install.mjs"
}

# 慢路径门禁入口（异步子壳内执行）：当前工作树版本的门禁脚本分析被推
# 提交的临时检出树；台账与锁仍指向主工作树（issues #405/#355）。
run_gate_for_pushed_tree() {
  unset_git_localization
  PLOTWEAVE_GATE_REPOSITORY_ROOT=$temp_worktree \
  PLOTWEAVE_GATE_PENDING_PATH=$pending_path \
  PLOTWEAVE_SONAR_LOCK_DIRECTORY=$lock_directory \
    exec "$main_root/scripts/sonar-quality-gate.sh"
}

# 快路径门禁入口（异步子壳内执行）：被推提交即当前工作树可证等价的
# 状态，在当前工作树直接执行完整门禁。
run_gate_for_current_tree() {
  exec "$main_root/scripts/sonar-quality-gate.sh"
}
