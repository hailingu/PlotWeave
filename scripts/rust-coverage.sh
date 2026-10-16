#!/bin/sh
# 生成 Rust 语句（行）覆盖率 LCOV 报告（issue #169）：口径、排除范围与
# 基线见 docs/development/rust-standard.md「测试覆盖率」。可独立运行建立
# 基线，也被 sonar-quality-gate.sh 在每次分析前调用（与前端 LCOV 同款
# 序列化与校验语义）。

set -eu

script_directory=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
# 门禁根覆盖（issue #405）：与 sonar-quality-gate.sh 同源的注入点——
# pre-push 慢路径经 PLOTWEAVE_GATE_REPOSITORY_ROOT 在被推提交的临时
# 检出树上生成覆盖率。
repository_root=${PLOTWEAVE_GATE_REPOSITORY_ROOT:-$(CDPATH= cd -- "$script_directory/.." && pwd)}

llvm_cov_bin=${PLOTWEAVE_CARGO_LLVM_COV_BIN:-cargo-llvm-cov}
rust_coverage_report_path=${PLOTWEAVE_RUST_COVERAGE_REPORT_PATH:-$repository_root/src-tauri/target/coverage/lcov-rust.info}
tauri_report_path=$rust_coverage_report_path.tauri
crates_report_path=$rust_coverage_report_path.crates

cd "$repository_root"

# 输出一致的失败原因并终止。
fail() {
  printf 'Rust 覆盖率生成失败：%s\n' "$1" >&2
  exit 1
}

command -v "$llvm_cov_bin" >/dev/null 2>&1 ||
  # $var 后不得紧跟多字节字符（macOS /bin/sh 即 bash 3.2 会并入变量名判
  # unbound），故变量置于消息末尾
  fail "缺少命令（安装：cargo install cargo-llvm-cov）：$llvm_cov_bin"

# CPU 预算与 sonar-quality-gate.sh 同源（owner 指示 2026-10-16；默认值
# 改固定 4 为 owner 于 2026-10-16 评审 5545658713 的再次指示，决策与
# 实测基线见 docs/development/quality-gate-cost.md「Gate CPU Budget」）：
# 优先继承 PLOTWEAVE_GATE_CPU_BUDGET（门禁解析并导出的同一数值），独立
# 运行且未设置时默认 4（固定值，不随机器核数浮动）。--jobs 限制编译
# 并行，RUST_TEST_THREADS 限制测试执行并行；目标选择与报告口径不变。
# 非法覆盖以稳定诊断码阻断、不静默回退。
coverage_jobs=${PLOTWEAVE_GATE_CPU_BUDGET:-}
case $coverage_jobs in
  '')
    coverage_jobs=4
    ;;
  *[!0-9]*)
    fail '[GATE_CPU_BUDGET_INVALID] PLOTWEAVE_GATE_CPU_BUDGET 须为正整数；已拒绝，不做静默回退'
    ;;
  *)
    [ "$coverage_jobs" -ge 1 ] ||
      fail '[GATE_CPU_BUDGET_INVALID] PLOTWEAVE_GATE_CPU_BUDGET 须为正整数；已拒绝，不做静默回退'
    ;;
esac
export RUST_TEST_THREADS=$coverage_jobs

# 两个 Cargo workspace 独立采样；任何失败均阻断，临时报告随脚本退出删除。
trap 'rm -f "$tauri_report_path" "$crates_report_path"' 0

printf '%s\n' '[coverage] 生成 Rust 语句覆盖率（LCOV，lib + media_format_leaf 目标，稳定版工具链无分支口径）……'
printf '[coverage] 并行度预算：%s（编译 --jobs 与 RUST_TEST_THREADS 同值）\n' "$coverage_jobs"
# llvm-cov 不创建报告父目录：先建（首次运行 target/coverage 不存在）
mkdir -p "$(dirname "$rust_coverage_report_path")"
# 目标选择（PR #223 评审）：--lib 度量产品库由库测试套件执行的语句，
# --test media_format_leaf 纳入独立的叶子集成测试目标（media_format.rs
# 的边界回归，issue #146）；native_quit 为 macOS 专属 AppKit 子进程
# 夹具，不在此报告（记录边界）。--branch 需要 nightly 的
# -Z coverage-options=branch（rust-toolchain.toml 钉死稳定版），故不启用。
"$llvm_cov_bin" llvm-cov --lib --test media_format_leaf --lcov \
  --output-path "$tauri_report_path" \
  --manifest-path src-tauri/Cargo.toml \
  --jobs "$coverage_jobs"

# core 的单元测试及 FFI 的 ABI 集成测试在独立 workspace 内执行；只执行
# 宿主测试会把迁出的内核单元测试遗漏，不能用较小的报告代替原有度量。
set -- "$tauri_report_path"
if [ -f crates/Cargo.toml ]; then
  "$llvm_cov_bin" llvm-cov --workspace --lib --test abi --lcov \
    --output-path "$crates_report_path" \
    --manifest-path crates/Cargo.toml \
    --jobs "$coverage_jobs"
  set -- "$tauri_report_path" "$crates_report_path"
fi
# issue #405：当前脚本也检查历史被推树；尚未提取 core 的树只有宿主
# workspace。按被检树清单选范围，存在 crates 时仍强制生成并验证它。

# 独立验证每份输入，防一份有效报告掩盖另一 workspace 的缺失或损坏。
for workspace_report in "$@"; do
  [ -s "$workspace_report" ] || fail "覆盖率报告缺失或为空：$workspace_report"
  grep -q '^SF:' "$workspace_report" || fail "覆盖率报告没有任何源文件记录：$workspace_report"
  grep -Eq '^DA:[0-9]+,[1-9][0-9]*' "$workspace_report" || fail "覆盖率报告没有任何已覆盖代码行：$workspace_report"
done

# LCOV 行契约：同一 SF+行号只有一个分母，任一 workspace 命中即覆盖。
# 路径转成仓库相对路径，保留零命中行；函数/分支不在稳定版行覆盖率口径。
awk -v prefix="$repository_root/" '
  /^SF:/ {
    file = substr($0, 4)
    if (index(file, prefix) == 1) file = substr(file, length(prefix) + 1)
    if (file == "") exit 1
    files[file] = 1
  }
  /^DA:/ {
    if (file == "" || $0 !~ /^DA:[0-9]+,[0-9]+(,[^,]+)?$/) exit 1
    split(substr($0, 4), fields, ",")
    key = file SUBSEP fields[1]
    hits[key] = (hits[key] || fields[2] + 0 > 0) ? 1 : 0
    lines[key] = 1
  }
  /^end_of_record$/ { file = "" }
  END {
    for (source in files) {
      print "SF:" source
      total = 0; covered = 0
      for (key in lines) {
        split(key, parts, SUBSEP)
        if (parts[1] != source) continue
        print "DA:" parts[2] "," hits[key]
        total += 1; covered += hits[key]
      }
      print "LF:" total
      print "LH:" covered
      print "end_of_record"
    }
  }
' "$@" > "$rust_coverage_report_path" ||
  fail 'Rust workspace 覆盖率报告包含无效 LCOV 行记录'

[ -s "$rust_coverage_report_path" ] ||
  fail "覆盖率报告缺失或为空：$rust_coverage_report_path"
grep -q '^SF:' "$rust_coverage_report_path" ||
  fail "覆盖率报告没有任何源文件记录：$rust_coverage_report_path"
grep -Eq '^DA:[0-9]+,[1-9][0-9]*' "$rust_coverage_report_path" ||
  fail "覆盖率报告没有任何已覆盖代码行：$rust_coverage_report_path"

printf '%s\n' "[coverage] Rust 覆盖率报告已生成：$rust_coverage_report_path"
