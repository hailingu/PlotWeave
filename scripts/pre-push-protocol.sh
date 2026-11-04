# POSIX ref scope protocol for pre-push (#948).
# Functions consume the entry hook's explicit ref/manifest state and do not register traps.

# 解析待推本地 sha 为其指向的提交：注释标签 peel 到提交，非提交对象
#（树 / 斑点）失败——fail-closed，不猜测分析对象。stderr 静默：诊断以
# 调用方的失败消息为准（--quiet 不抑制对象类型不匹配的 error 输出）。
resolve_pushed_commit() {
  case $1 in
    *[!0-9a-fA-F]* | '') return 1 ;;
  esac
  git rev-parse --verify --quiet "$1^{commit}" 2>/dev/null
}

# 变更范围基线（owner 指示 2026-10-18）：已有远端分支用远端旧 tip 的
# 范围，新建分支优先用本地 develop 的 merge-base，其次 origin/develop，最后退回
# 被推提交的父提交。已有 tip 缺对象或无法确定基线时返回非零，调用方按 full 处理。
scope_base_for_commit() {
  commit=$1
  remote_sha=$2
  if [ "$remote_sha" != "$zero_sha" ]; then
    git cat-file -e "$remote_sha^{commit}" 2>/dev/null || return 1
    printf '%s\n' "$remote_sha"
    return 0
  fi
  if git rev-parse --verify --quiet develop^{commit} >/dev/null 2>&1; then
    git merge-base develop "$commit" 2>/dev/null && return 0
  fi
  if git rev-parse --verify --quiet origin/develop^{commit} >/dev/null 2>&1; then
    git merge-base origin/develop "$commit" 2>/dev/null && return 0
  fi
  if git rev-parse --verify --quiet "$commit^" >/dev/null 2>&1; then
    git rev-parse "$commit^" 2>/dev/null && return 0
  fi
  return 1
}

# 收集每个 ref 的独立范围；文档差异逐个检查，不能只检查共享提交的首个基线。
collect_ref_scope() {
  scope_base=$(scope_base_for_commit "$commit" "$remote_sha" 2>/dev/null || true)
  if [ -n "$scope_base" ]; then
    gate_scope=$("$node_bin" "$main_root/scripts/gate-scope.ts" \
      --base "$scope_base" --head "$commit") ||
      fail "无法分类待推送提交 $commit 的变更范围：$local_ref"
  else
    gate_scope=full
  fi
  case $gate_scope in
    docs)
      "$main_root/scripts/check-docs.sh" "$scope_base" "$commit" ||
        fail "文档差异检查失败：$local_ref"
      ;;
    frontend | rust | native | full) ;;
    *) fail "未知的门禁范围（${gate_scope}）：$local_ref" ;;
  esac
  printf '%s %s %s\n' "$commit" "$gate_scope" "$local_ref" >> "$scope_manifest_path"
}

# 合并同一提交的所有 ref 范围：docs 为中性；不同实现栈或任一 full 都取 full。
# 范围收集全部完成后才调用，因此结果与 stdin 中的 ref 顺序无关。
aggregate_commit_scope() {
  awk -v commit="$1" '
    BEGIN { scope = "docs" }
    $1 == commit && $2 != "docs" {
      if (scope == "docs") scope = $2
      else if (scope != $2) scope = "full"
    }
    END { print scope }
  ' "$scope_manifest_path"
}
