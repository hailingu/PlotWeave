#!/bin/sh
# Rust 模块图守卫元检查（issues #471/#495）：用工具链的注册名清单与
# 逐例成功结果核对版本化名称基线，拒绝挂载点丢失、用例消失和 #[ignore]。
# 基线来自真实 libtest 枚举；新增/删除/替名必须一起评审更新基线，禁止
# 自动写回放行。原名函数体被空化的语义退化不属于此存活检查的能力。
# 串行挂在门禁 Rust 阶段及 CI rust 任务，不进入并行 Vitest 冷构建。

set -eu
LC_ALL=C
export LC_ALL

script_directory=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
# issue #405：读取被推提交的检出树，禁止借宿主基线放行另一棵树。
repository_root=${PLOTWEAVE_GATE_REPOSITORY_ROOT:-$(CDPATH= cd -- "$script_directory/.." && pwd)}
cargo_bin=${PLOTWEAVE_CARGO_BIN:-cargo}
node_bin=${PLOTWEAVE_NODE_BIN:-node}

# 输出一致的阻塞原因并终止。
fail() {
  printf '模块图守卫元检查失败：%s\n' "$1" >&2
  exit 1
}

cd "$repository_root"
command -v "$cargo_bin" >/dev/null 2>&1 || fail "缺少命令：$cargo_bin"
command -v "$node_bin" >/dev/null 2>&1 || fail "缺少命令：$node_bin"

# JSON 名称清单是基线契约：非空、唯一的 module_graph:: 限定名。
# Node 已是完整门禁的工具依赖；失败保留解析原因，不默认为空基线。
if ! expected=$("$node_bin" -e '
  const fs = require("node:fs");
  try {
    const baseline = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    if (baseline?.version !== 1 || !Array.isArray(baseline.tests) ||
        baseline.tests.length === 0 || baseline.tests.some(name =>
          typeof name !== "string" || !/^module_graph::[^\s:]+(?:::[^\s:]+)*$/.test(name)) ||
        new Set(baseline.tests).size !== baseline.tests.length) {
      throw new Error("需要 version: 1 与非空、唯一的 module_graph:: 名称数组 tests");
    }
    process.stdout.write(baseline.tests.join("\n") + "\n");
  } catch (error) {
    process.stderr.write("守卫名称基线不可用：" + error.message + "\n");
    process.exit(1);
  }
' scripts/rust-module-graph-guard-baseline.json 2>&1); then
  fail "$expected"
fi
expected=$(printf '%s\n' "$expected" | sort)
guard_test_floor=$(printf '%s\n' "$expected" | wc -l | tr -d ' ')

# 先枚举精确前缀，避免 Cargo 子串过滤将无关用例补入守卫计数。
if ! listing=$("$cargo_bin" test --lib --manifest-path src-tauri/Cargo.toml -- --list 2>&1); then
  printf '%s\n' "$listing" | tail -n 40 >&2
  fail 'cargo test --lib -- --list 失败（工具链或编译错误，尾部诊断见上）'
fi
registered=$(printf '%s\n' "$listing" | awk '/^module_graph::.*: test$/ { sub(/: test$/, ""); print }' | sort)
count=$(printf '%s\n' "$registered" | awk 'NF { count++ } END { print count+0 }')
[ "$count" -ge "$guard_test_floor" ] ||
  fail "[RUST_MODULE_GRAPH_LIST_MISMATCH] 守卫用例数 $count 跌破存活下限 ${guard_test_floor}: lib.rs 挂载点 #[cfg(test)] mod module_graph 被移除或模块被清空？（issue #471）"
[ "$registered" = "$expected" ] ||
  fail '[RUST_MODULE_GRAPH_LIST_MISMATCH] 守卫注册名称与版本化基线不一致：新增、删除或替名须同步评审更新基线（issue #495）'

# pretty + 单线程保证完整逐例行不被进度点或并发输出打断；不能使用
# --include-ignored 强制执行，从而掩盖常规 cargo test 静默忽略的回归。
if ! execution=$("$cargo_bin" test --lib --manifest-path src-tauri/Cargo.toml -- module_graph:: --format pretty --color never --test-threads=1 2>&1); then
  printf '%s\n' "$execution" | tail -n 40 >&2
  fail 'cargo test module_graph:: 执行失败（尾部诊断见上，issue #495）'
fi
passed=$(printf '%s\n' "$execution" | awk '/^test module_graph::[^[:space:]]+( - should panic)? \.\.\. ok$/ { sub(/^test /, ""); sub(/ \.\.\. ok$/, ""); sub(/ - should panic$/, ""); print }' | sort)
[ "$passed" = "$expected" ] || {
  printf '%s\n' "$execution" | tail -n 40 >&2
  fail '守卫实际通过名称与基线不一致：存在 ignored、未执行、重复或替名用例（issue #495）'
}

# 摘要必须唯一、成功且零 failed/ignored；总通过数不能少于具名守卫数。
# 无关的子串匹配用例可多出，但不能替代上述任何具名守卫的成功结果。
summary_count=$(printf '%s\n' "$execution" | grep -c '^test result:') || summary_count=0
summary_passed=$(printf '%s\n' "$execution" | awk '/^test result: ok\. [0-9]+ passed; 0 failed; 0 ignored; 0 measured; [0-9]+ filtered out; finished in / { print $4 }')
[ "$summary_count" -eq 1 ] && [ -n "$summary_passed" ] && [ "$summary_passed" -ge "$guard_test_floor" ] || {
  printf '%s\n' "$execution" | tail -n 40 >&2
  fail '守卫执行摘要缺失、畸形或不一致：要求唯一成功摘要且 failed/ignored 为零（issue #495）'
}

printf '[meta-guard] 模块图守卫元检查通过：%s 个 module_graph:: 用例实际通过（版本化基线 %s，ignored=0，issues #471/#495）。\n' \
  "$count" "$guard_test_floor"
