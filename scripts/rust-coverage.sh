#!/bin/sh
# 生成 Rust 语句（行）覆盖率 LCOV 报告（issue #169）：口径、排除范围与
# 基线见 docs/development/rust-standard.md「测试覆盖率」。可独立运行建立
# 基线，也被 sonar-quality-gate.sh 在每次分析前调用（与前端 LCOV 同款
# 序列化与校验语义）。

set -eu

script_directory=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
repository_root=$(CDPATH= cd -- "$script_directory/.." && pwd)

llvm_cov_bin=${PLOTWEAVE_CARGO_LLVM_COV_BIN:-cargo-llvm-cov}
rust_coverage_report_path=${PLOTWEAVE_RUST_COVERAGE_REPORT_PATH:-$repository_root/src-tauri/target/coverage/lcov-rust.info}

cd "$repository_root"

# 输出一致的失败原因并终止。
fail() {
  printf 'Rust 覆盖率生成失败：%s\n' "$1" >&2
  exit 1
}

command -v "$llvm_cov_bin" >/dev/null 2>&1 ||
  fail "缺少命令：$llvm_cov_bin（安装：cargo install cargo-llvm-cov）"

printf '%s\n' '[coverage] 生成 Rust 语句覆盖率（LCOV，lib + media_format_leaf 目标，稳定版工具链无分支口径）……'
# llvm-cov 不创建报告父目录：先建（首次运行 target/coverage 不存在）
mkdir -p "$(dirname "$rust_coverage_report_path")"
# 目标选择（PR #223 评审）：--lib 度量产品库由库测试套件执行的语句，
# --test media_format_leaf 纳入独立的叶子集成测试目标（media_format.rs
# 的边界回归，issue #146）；native_quit 为 macOS 专属 AppKit 子进程
# 夹具，不在此报告（记录边界）。--branch 需要 nightly 的
# -Z coverage-options=branch（rust-toolchain.toml 钉死稳定版），故不启用。
"$llvm_cov_bin" llvm-cov --lib --test media_format_leaf --lcov \
  --output-path "$rust_coverage_report_path" \
  --manifest-path src-tauri/Cargo.toml

[ -s "$rust_coverage_report_path" ] ||
  fail "覆盖率报告缺失或为空：$rust_coverage_report_path"
grep -q '^SF:' "$rust_coverage_report_path" ||
  fail "覆盖率报告没有任何源文件记录：$rust_coverage_report_path"
grep -Eq '^DA:[0-9]+,[1-9][0-9]*' "$rust_coverage_report_path" ||
  fail "覆盖率报告没有任何已覆盖代码行：$rust_coverage_report_path"

printf '%s\n' "[coverage] Rust 覆盖率报告已生成：$rust_coverage_report_path"
